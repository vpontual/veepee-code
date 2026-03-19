import { Ollama } from 'ollama';
import type { Message, ToolCall } from 'ollama';
import type { Config } from './config.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ModelRoster } from './benchmark.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SubAgentRole = 'search' | 'review' | 'summarize';

export interface SubAgentResult {
  role: SubAgentRole;
  model: string;
  content: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  elapsed: number;
  success: boolean;
  error?: string;
}

// ─── Sub-Agent ───────────────────────────────────────────────────────────────

/**
 * Lightweight sub-agent that runs on a smaller/faster model for specific tasks.
 * Spawned by the main agent to offload search, code review, or summarization.
 */
export class SubAgent {
  private ollama: Ollama;
  private registry: ToolRegistry;
  private model: string;
  private role: SubAgentRole;
  private maxTurns: number;

  constructor(config: Config, registry: ToolRegistry, roster: ModelRoster | null, role: SubAgentRole) {
    this.ollama = new Ollama({ host: config.proxyUrl });
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

// ─── Sub-Agent Manager ───────────────────────────────────────────────────────

export class SubAgentManager {
  private config: Config;
  private registry: ToolRegistry;
  private roster: ModelRoster | null;

  constructor(config: Config, registry: ToolRegistry, roster: ModelRoster | null) {
    this.config = config;
    this.registry = registry;
    this.roster = roster;
  }

  /** Spawn a sub-agent for a specific role */
  spawn(role: SubAgentRole): SubAgent {
    return new SubAgent(this.config, this.registry, this.roster, role);
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
}
