import { Ollama } from 'ollama';
import type { Message, ToolCall } from 'ollama';
import type { Config } from './config.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ModelRoster } from './benchmark.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SubAgentRole = 'search' | 'review' | 'summarize' | 'task';

export interface SubAgentResult {
  role: SubAgentRole;
  model: string;
  content: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  elapsed: number;
  success: boolean;
  error?: string;
}

/** A live subagent tracked by the manager. Used for /agents listing and
 *  the background-agent UX (Phase 3 F8). */
export interface TrackedAgent {
  id: string;
  description: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: number;
  completedAt?: number;
  result?: SubAgentResult;
  /** When run_in_background is true, the parent doesn't await the promise.
   *  /agents output <id> resolves it on demand. */
  promise?: Promise<SubAgentResult>;
  /** True when spawned with run_in_background. Used to gate inline TUI
   *  notifications so foreground tasks (whose tool_result already prints)
   *  don't print a redundant "completed" toast. */
  background?: boolean;
}

export interface RunTaskOptions {
  prompt: string;
  /** Model override — proxy routes by model name to whichever fleet server
   *  has it loaded (e.g. "gemma4:26b-a4b" → AGX, "qwen3:8b" → Nano 1).
   *  Default: parent's primary model (will hit the same fleet server,
   *  battling for vLLM batch slots — fine for fan-out on independent
   *  contexts but throughput-capped). */
  model?: string;
  /** Tool allowlist. Default: read-only + web tools. Subagents are
   *  intentionally restricted by default; the parent is responsible for
   *  opting them into mutating tools when that's the goal. */
  tools?: string[];
  /** Short label for /agents listing. */
  description?: string;
  /** Max conversation turns before forcing return. Default: 8. */
  maxTurns?: number;
  /** When true, runTask returns immediately with the tracked-agent ID.
   *  Output retrievable via the manager. Phase 3 F8. */
  runInBackground?: boolean;
}

// ─── Sub-Agent ───────────────────────────────────────────────────────────────

/**
 * Lightweight sub-agent that runs on a smaller/faster model for specific tasks.
 * Spawned by the main agent to offload search, code review, or summarization.
 */
type LegacyRole = 'search' | 'review' | 'summarize';

export class SubAgent {
  private ollama: Ollama;
  private registry: ToolRegistry;
  private model: string;
  private role: LegacyRole;
  private maxTurns: number;

  constructor(config: Config, registry: ToolRegistry, roster: ModelRoster | null, role: LegacyRole) {
    this.ollama = new Ollama({ host: config.proxyUrl, headers: { "x-ollama-source": "vcode" } });
    this.registry = registry;
    this.role = role;
    this.maxTurns = role === 'search' ? 3 : 5;

    // Pick model based on role and roster
    switch (role) {
      case 'search':
        this.model = roster?.search || roster?.chat || 'qwen3:8b';
        break;
      case 'review':
        this.model = roster?.plan || roster?.act || 'qwen3.5:35b';
        break;
      case 'summarize':
        this.model = roster?.chat || roster?.search || 'qwen3:8b';
        break;
      default: {
        // Defensive: should be unreachable thanks to the LegacyRole type,
        // but keeps strict TS happy that `model` is definitely assigned.
        const _exhaustive: never = role;
        this.model = _exhaustive;
      }
    }
  }

  /** Get the system prompt for this sub-agent role */
  private getSystemPrompt(): string {
    switch (this.role) {
      case 'search':
        return `You are a search sub-agent. Your job is to find information using web_search, web_fetch, and news tools. Be thorough but fast. Return only the relevant findings — no commentary.`;
      case 'review':
        return `You are a code review sub-agent. Read the specified files and provide a concise review: bugs, style issues, security concerns, and improvements. Be specific with line references.`;
      case 'summarize':
        return `You are a summarization sub-agent. Read the provided content and produce a concise, structured summary. Focus on key points, decisions, and action items.`;
      default: {
        const _exhaustive: never = this.role;
        return _exhaustive;
      }
    }
  }

  /** Get available tools for this role */
  private getTools() {
    const allTools = this.registry.toOllamaTools();
    switch (this.role) {
      case 'search':
        return allTools.filter(t => {
          const name = t.function?.name || '';
          return ['web_search', 'web_fetch', 'http_request', 'news'].includes(name);
        });
      case 'review':
        return allTools.filter(t => {
          const name = t.function?.name || '';
          return ['read_file', 'glob', 'grep', 'list_files'].includes(name);
        });
      case 'summarize':
        return allTools.filter(t => {
          const name = t.function?.name || '';
          return ['read_file', 'web_fetch'].includes(name);
        });
      default: {
        const _exhaustive: never = this.role;
        return _exhaustive;
      }
    }
  }

  /** Run the sub-agent with a task prompt */
  async run(task: string): Promise<SubAgentResult> {
    const start = Date.now();
    const toolCallResults: SubAgentResult['toolCalls'] = [];

    const messages: Message[] = [
      { role: 'system', content: this.getSystemPrompt() },
      { role: 'user', content: task },
    ];

    const tools = this.getTools();
    let finalContent = '';

    try {
      for (let turn = 0; turn < this.maxTurns; turn++) {
        const response = await this.ollama.chat({
          model: this.model,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          stream: false,
          keep_alive: '30m',
          options: { num_predict: 1024 },
        } as never) as unknown as { message: { content: string; tool_calls?: ToolCall[] } };

        const content = response.message.content || '';
        const toolCalls = response.message.tool_calls || [];

        messages.push({
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });

        // No tool calls — done
        if (toolCalls.length === 0) {
          finalContent = content;
          break;
        }

        // Execute tool calls
        for (const call of toolCalls) {
          const toolName = call.function.name;
          const toolArgs = (call.function.arguments || {}) as Record<string, unknown>;
          const result = await this.registry.execute(toolName, toolArgs);
          const resultContent = result.success ? result.output : `Error: ${result.error}`;

          messages.push({ role: 'tool', content: resultContent });
          toolCallResults.push({ name: toolName, args: toolArgs, result: resultContent });
        }
      }

      return {
        role: this.role,
        model: this.model,
        content: finalContent,
        toolCalls: toolCallResults,
        elapsed: Date.now() - start,
        success: true,
      };
    } catch (err) {
      return {
        role: this.role,
        model: this.model,
        content: '',
        toolCalls: toolCallResults,
        elapsed: Date.now() - start,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ─── Generic Task SubAgent ───────────────────────────────────────────────────
//
// The Task tool's runtime. Differs from the role-based SubAgent above in that
// it accepts arbitrary model + tools at spawn time and runs as many turns as
// needed (capped). Used directly by the model via the `task` tool.

class GenericSubAgent {
  private ollama: Ollama;
  private registry: ToolRegistry;
  private model: string;
  private allowedTools: Set<string> | null;
  private maxTurns: number;
  private aborted = false;

  constructor(
    config: Config,
    registry: ToolRegistry,
    model: string,
    allowedTools: string[] | null,
    maxTurns: number,
  ) {
    this.ollama = new Ollama({ host: config.proxyUrl, headers: { "x-ollama-source": "vcode" } });
    this.registry = registry;
    this.model = model;
    this.allowedTools = allowedTools ? new Set(allowedTools) : null;
    this.maxTurns = maxTurns;
  }

  abort(): void { this.aborted = true; }

  async run(prompt: string): Promise<SubAgentResult> {
    const start = Date.now();
    const toolCallResults: SubAgentResult['toolCalls'] = [];
    const messages: Message[] = [
      {
        role: 'system',
        content:
          'You are a subagent spawned by a parent agent for a focused task. ' +
          'You have your own conversation context. Use the tools available to ' +
          'complete the task, then return a concise final answer. ' +
          'Do not delegate further — finish the task yourself.',
      },
      { role: 'user', content: prompt },
    ];

    // Filter tools by allowlist (default: read-only + web)
    const defaultAllow = new Set(['read_file', 'glob', 'grep', 'list_files', 'web_search', 'web_fetch', 'http_request']);
    const allowSet = this.allowedTools ?? defaultAllow;
    const tools = this.registry.toOllamaTools().filter((t) => {
      const name = t.function?.name || '';
      return allowSet.has(name);
    });

    let finalContent = '';
    try {
      for (let turn = 0; turn < this.maxTurns; turn++) {
        if (this.aborted) {
          return {
            role: 'task', model: this.model, content: finalContent, toolCalls: toolCallResults,
            elapsed: Date.now() - start, success: false, error: 'aborted',
          };
        }
        const response = await this.ollama.chat({
          model: this.model,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          stream: false,
          keep_alive: '30m',
          options: { num_predict: 1024 },
        } as never) as unknown as { message: { content: string; tool_calls?: ToolCall[] } };

        const content = response.message.content || '';
        const toolCalls = response.message.tool_calls || [];
        messages.push({
          role: 'assistant', content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });

        if (toolCalls.length === 0) {
          finalContent = content;
          break;
        }

        for (const call of toolCalls) {
          const toolName = call.function.name;
          const toolArgs = (call.function.arguments || {}) as Record<string, unknown>;
          // Subagent honors its own allowlist — block silently with a clear
          // tool result so the model can recover within its turn budget.
          if (!allowSet.has(toolName)) {
            const errMsg = `Tool '${toolName}' not allowed for this subagent. Allowed: ${[...allowSet].join(', ')}`;
            messages.push({ role: 'tool', content: errMsg });
            toolCallResults.push({ name: toolName, args: toolArgs, result: errMsg });
            continue;
          }
          const result = await this.registry.execute(toolName, toolArgs);
          const resultContent = result.success ? result.output : `Error: ${result.error}`;
          messages.push({ role: 'tool', content: resultContent });
          toolCallResults.push({ name: toolName, args: toolArgs, result: resultContent });
        }
      }

      return {
        role: 'task', model: this.model,
        content: finalContent || '(subagent reached max turns without final answer)',
        toolCalls: toolCallResults,
        elapsed: Date.now() - start,
        success: !!finalContent,
        ...(finalContent ? {} : { error: 'max turns reached' }),
      };
    } catch (err) {
      return {
        role: 'task', model: this.model,
        content: '', toolCalls: toolCallResults,
        elapsed: Date.now() - start,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ─── Sub-Agent Manager ───────────────────────────────────────────────────────

export class SubAgentManager {
  private config: Config;
  private registry: ToolRegistry;
  private roster: ModelRoster | null;
  /** Max concurrent subagents — caps fan-out to protect proxy slot capacity.
   *  Practical vLLM ceiling on a single GPU is ~4 before throughput collapses;
   *  with multi-server fleet routing, the cap is effectively per-server.
   *  Overridable via settings.json `subagent.maxConcurrent`. */
  private maxConcurrent = 4;
  /** When set, runTask rejects model names not in this list. Prevents the
   *  model from typo-routing into "load this on Ollama" expensive paths
   *  on fleets with pinned-per-server models. */
  private allowedModels: Set<string> | null = null;
  private running = new Map<string, GenericSubAgent>();
  private tracked = new Map<string, TrackedAgent>();
  private nextId = 1;
  /** Callback fired when ANY tracked subagent transitions to a terminal
   *  state (completed/failed/aborted). Foreground tasks still fire it —
   *  the parent already sees the inline result, but Notification hooks
   *  may want every transition. TUI registers this; default is no-op. */
  private onTransition: ((agent: TrackedAgent) => void) | null = null;

  constructor(config: Config, registry: ToolRegistry, roster: ModelRoster | null) {
    this.config = config;
    this.registry = registry;
    this.roster = roster;
    // Apply user constraints from settings if present.
    if (config.subagent?.maxConcurrent && config.subagent.maxConcurrent > 0) {
      this.maxConcurrent = config.subagent.maxConcurrent;
    }
    if (config.subagent?.allowedModels && config.subagent.allowedModels.length > 0) {
      this.allowedModels = new Set(config.subagent.allowedModels);
    }
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
  }

  /** Register a transition handler. Replaces any prior handler. */
  setOnTransition(handler: ((agent: TrackedAgent) => void) | null): void {
    this.onTransition = handler;
  }

  /** Diagnostic for /agents — surface what restrictions are active. */
  getAllowedModels(): string[] | null {
    return this.allowedModels ? [...this.allowedModels] : null;
  }

  /** Spawn a sub-agent for a specific role */
  spawn(role: SubAgentRole): SubAgent {
    return new SubAgent(this.config, this.registry, this.roster, role as 'search' | 'review' | 'summarize');
  }

  /** Run a search task on a lightweight model */
  async search(query: string): Promise<SubAgentResult> {
    return this.spawn('search').run(`Search the web for: ${query}\n\nReturn the most relevant findings as a concise summary.`);
  }

  /** Run a code review on specified files */
  async review(files: string[], focus?: string): Promise<SubAgentResult> {
    const fileList = files.map(f => `- ${f}`).join('\n');
    const focusLine = focus ? `\nFocus on: ${focus}` : '';
    return this.spawn('review').run(`Review these files for bugs, style issues, and security concerns:\n${fileList}${focusLine}`);
  }

  /** Summarize content (file, URL, or text) */
  async summarize(content: string): Promise<SubAgentResult> {
    return this.spawn('summarize').run(`Summarize the following:\n\n${content}`);
  }

  /** Run multiple sub-agents in parallel */
  async parallel(tasks: Array<{ role: SubAgentRole; prompt: string }>): Promise<SubAgentResult[]> {
    return Promise.all(tasks.map(t => this.spawn(t.role).run(t.prompt)));
  }

  // ─── Generic Task API (used by the `task` tool) ─────────────────────────

  /** Run a task subagent. Foreground returns the result; background returns
   *  immediately and stores the promise so the parent can collect later. */
  async runTask(opts: RunTaskOptions): Promise<{ id: string; result?: SubAgentResult }> {
    // Model allowlist guard — when set, rejects any model not in the list
    // before spawning. Prevents the model from typo-routing into expensive
    // "load this on Ollama" paths on fleets with pinned-per-server models.
    const requestedModel = opts.model ?? this.defaultTaskModel();
    if (this.allowedModels && !this.allowedModels.has(requestedModel)) {
      const id = this.assignId();
      const allowed = [...this.allowedModels].join(', ');
      const failed: SubAgentResult = {
        role: 'task',
        model: requestedModel,
        content: '',
        toolCalls: [],
        elapsed: 0,
        success: false,
        error: `Model '${requestedModel}' not in subagent allowedModels. Allowed: ${allowed}. Adjust settings.json subagent.allowedModels if this should be permitted.`,
      };
      this.tracked.set(id, {
        id,
        description: opts.description ?? opts.prompt.slice(0, 60),
        model: requestedModel,
        status: 'failed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        result: failed,
      });
      return { id, result: failed };
    }

    if (this.running.size >= this.maxConcurrent) {
      const id = this.assignId();
      const failed: SubAgentResult = {
        role: 'task',
        model: opts.model ?? '(unset)',
        content: '',
        toolCalls: [],
        elapsed: 0,
        success: false,
        error: `Subagent capacity reached (${this.running.size}/${this.maxConcurrent} running). Try again after one finishes, or raise the cap.`,
      };
      this.tracked.set(id, {
        id,
        description: opts.description ?? opts.prompt.slice(0, 60),
        model: opts.model ?? '(unset)',
        status: 'failed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        result: failed,
      });
      return { id, result: failed };
    }

    const id = this.assignId();
    const description = opts.description ?? opts.prompt.slice(0, 60);
    const agent = new GenericSubAgent(
      this.config,
      this.registry,
      requestedModel,
      opts.tools ?? null,
      opts.maxTurns ?? 8,
    );

    this.running.set(id, agent);
    const tracked: TrackedAgent = {
      id,
      description,
      model: requestedModel,
      status: 'running',
      startedAt: Date.now(),
      background: !!opts.runInBackground,
    };
    this.tracked.set(id, tracked);

    const promise = agent.run(opts.prompt).then((result) => {
      this.running.delete(id);
      tracked.completedAt = Date.now();
      tracked.result = result;
      // If status was already set to 'aborted' (via abort()), keep that —
      // otherwise transition to completed/failed based on the result.
      if (tracked.status === 'running') {
        tracked.status = result.success ? 'completed' : 'failed';
      }
      try { this.onTransition?.(tracked); } catch { /* handler should not throw */ }
      return result;
    });
    tracked.promise = promise;

    if (opts.runInBackground) {
      // Eager catch so we don't get unhandled-rejection warnings if the
      // parent never collects the result.
      promise.catch(() => undefined);
      return { id };
    }
    const result = await promise;
    return { id, result };
  }

  /** Default model for tasks — falls back to roster heavy or 'qwen3:8b'.
   *  Subagents do NOT inherit the parent's lockModel; they may explicitly
   *  pick a fleet server via `model` override. */
  private defaultTaskModel(): string {
    return this.roster?.act || this.roster?.plan || this.roster?.search || 'qwen3:8b';
  }

  private assignId(): string {
    return 'sa-' + (this.nextId++).toString().padStart(3, '0');
  }

  /** List tracked subagents (running + recent completions). */
  listAgents(): TrackedAgent[] {
    return [...this.tracked.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Retrieve a tracked agent's result. Awaits the underlying promise if
   *  the agent is still running (e.g. /agents output <id> for a background). */
  async waitFor(id: string): Promise<SubAgentResult | null> {
    const t = this.tracked.get(id);
    if (!t) return null;
    if (t.result) return t.result;
    if (t.promise) return await t.promise;
    return null;
  }

  /** Best-effort abort. The current Ollama client doesn't expose a request
   *  abort signal, so abort just sets a flag; the agent stops at the next
   *  turn boundary. Tracked status becomes 'aborted'. */
  abort(id: string): boolean {
    const agent = this.running.get(id);
    if (!agent) return false;
    agent.abort();
    const t = this.tracked.get(id);
    if (t) t.status = 'aborted';
    return true;
  }

  /** Counts for /agents and capacity displays. */
  stats(): { running: number; max: number; total: number } {
    return {
      running: this.running.size,
      max: this.maxConcurrent,
      total: this.tracked.size,
    };
  }
}
