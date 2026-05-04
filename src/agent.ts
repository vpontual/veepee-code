import { Ollama } from 'ollama';
import type { Message, ToolCall } from 'ollama';
import type { Config } from './config.js';
import type { ToolRegistry } from './tools/registry.js';
import type { PermissionManager } from './permissions.js';
import type { BenchmarkResult } from './benchmark.js';
import { ContextManager, CHAT_TOOLS } from './context.js';
import { ModelManager } from './models.js';
import type { ModelRoster } from './benchmark.js';
import { SubAgentManager } from './subagent.js';
import { runHooks, shouldBlock, type HookExecResult } from './hooks.js';
import { previewEdit, previewWrite } from './diff.js';
import { PLAN_DISABLED_TOOLS } from './tools/plan-gate.js';
import { readFile, readFile as readFileAsync, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'path';
import { existsSync, readFileSync } from 'fs';

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'model_switch' | 'thinking' | 'done' | 'error' | 'permission_denied' | 'reset_stream' | 'hook_output';
  content?: string;
  name?: string;
  args?: Record<string, unknown>;
  success?: boolean;
  error?: string;
  from?: string;
  to?: string;
  // Token metrics from Ollama (available on 'done' events)
  evalCount?: number;      // tokens generated
  promptEvalCount?: number; // prompt tokens processed
  tokensPerSecond?: number; // actual generation speed
  // Hook metadata (available on 'hook_output' events)
  hookEvent?: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'Notification';
  hookLayer?: 'global' | 'project' | 'local';
  hookExitCode?: number;
  hookBlocked?: boolean;
}

// Planning intent detection patterns
const PLAN_PATTERNS = [
  /\bplan\b/i, /\bdesign\b/i, /\barchitect\b/i, /\bstrateg/i,
  /\bthink\s+(about|through)\b/i, /\bbrainstorm\b/i, /\bapproach\b/i,
  /\bhow\s+(should|would|could)\s+(we|i|you)\b/i,
  /\bbefore\s+(we|i|you)\s+(start|begin|implement|code|build)\b/i,
  /\bwhat('s|\s+is)\s+the\s+best\s+way\b/i,
  /\bbreak\s+(this|it)\s+down\b/i, /\bstep\s+by\s+step\b/i,
  /\bdeepen\b/i, /\belaborate\b/i, /\bexpand\s+on\b/i,
  /\blet'?s\s+think\b/i, /\bconsider\b/i,
];

export type AgentMode = 'act' | 'plan' | 'chat';
export type EffortLevel = 'low' | 'medium' | 'high';
export type PermissionMode = 'interactive' | 'auto_allow';

export class Agent {
  private ollama: Ollama;
  private context: ContextManager;
  private modelManager: ModelManager;
  private registry: ToolRegistry;
  private permissions: PermissionManager;
  private optimalContextSizes = new Map<string, number>();
  private mode: AgentMode = 'act';
  private previousModel: string | null = null;
  private roster: ModelRoster | null = null;
  private subAgents: SubAgentManager;
  private config: Config;
  private abortController: AbortController | null = null;
  private effort: EffortLevel = 'medium';
  private modelStick = false; // when true, mode switches don't change the model

  constructor(config: Config, registry: ToolRegistry, modelManager: ModelManager, permissions: PermissionManager) {
    this.ollama = new Ollama({ host: config.proxyUrl });
    this.context = new ContextManager();
    this.modelManager = modelManager;
    this.registry = registry;
    this.permissions = permissions;
    this.config = config;
    // Subagent manager is always available — initialized with null roster
    // so the `task` tool can use it before benchmark roster loads. Roster
    // will replace it once available (see loadRoster). Importantly, the
    // SAME instance persists, so registered tools holding a reference
    // continue to work after roster swap.
    this.subAgents = new SubAgentManager(this.config, this.registry, null);

    this.loadBenchmarkContextSizes();
    this.loadRoster();
  }

  /** Load the model roster from benchmark results */
  private async loadRoster(): Promise<void> {
    const rosterPath = resolve(process.env.HOME || '~', '.veepee-code', 'benchmarks', 'roster.json');
    if (!existsSync(rosterPath)) return;
    try {
      const data = await readFile(rosterPath, 'utf-8');
      this.roster = JSON.parse(data) as ModelRoster;
      // Re-instantiate subAgents with the freshly loaded roster. Anything
      // already holding a reference to the old instance will keep working
      // (it's still functional with null roster), but new spawns get
      // benchmark-informed model picks.
      this.subAgents = new SubAgentManager(this.config, this.registry, this.roster);
    } catch { /* ignore */ }
  }

  getMode(): AgentMode {
    return this.mode;
  }

  getRoster(): ModelRoster | null {
    return this.roster;
  }

  getModelStick(): boolean {
    return this.modelStick;
  }

  setModelStick(on: boolean): void {
    this.modelStick = on;
    if (on) {
      this.modelManager.setAutoSwitch(false);
    }
  }

  /** Enter plan mode — thinking ON, best reasoning model from roster (unless model_stick is on) */
  enterPlanMode(): { model: string } {
    this.mode = 'plan';
    this.previousModel = this.modelManager.getCurrentModel();

    if (!this.modelStick) {
      // Use roster's plan model if available
      const planModel = this.roster?.plan;
      if (planModel && this.modelManager.getProfile(planModel)) {
        this.modelManager.switchTo(planModel);
      } else {
        // Fallback: best heavy model with thinking
        const heavyModels = this.modelManager.getModelsByTier('heavy')
          .filter(m => m.capabilities.includes('tools'))
          .sort((a, b) => b.score - a.score);
        const thinker = heavyModels.find(m => m.capabilities.includes('thinking'));
        const best = thinker || heavyModels[0];
        if (best) this.modelManager.switchTo(best.name);
      }
    }

    this.modelManager.setAutoSwitch(false);
    this.context.setSystemPrompt(this.modelManager.getCurrentModel());
    this.context.setMode('plan');

    return { model: this.modelManager.getCurrentModel() };
  }

  /** Exit plan/chat mode — restore act model from roster (unless model_stick is on) */
  exitPlanMode(): void {
    this.mode = 'act';
    this.context.setMode('act');

    if (!this.modelStick) {
      // Use roster's act model, or restore previous
      const actModel = this.roster?.act;
      if (actModel && this.modelManager.getProfile(actModel)) {
        this.modelManager.switchTo(actModel);
      } else if (this.previousModel) {
        this.modelManager.switchTo(this.previousModel);
      }
      this.modelManager.setAutoSwitch(true);
    }
    this.previousModel = null;
    this.context.setSystemPrompt(this.modelManager.getCurrentModel());
  }

  /** Enter chat mode — web tools only, fastest conversational model from roster (unless model_stick is on) */
  enterChatMode(): { model: string } {
    this.mode = 'chat';
    this.previousModel = this.modelManager.getCurrentModel();
    this.context.setMode('chat');

    if (!this.modelStick) {
      // Use roster's chat model if available
      const chatModel = this.roster?.chat;
      if (chatModel && this.modelManager.getProfile(chatModel)) {
        this.modelManager.switchTo(chatModel);
        this.modelManager.setAutoSwitch(false);
        this.context.setSystemPrompt(chatModel);
        return { model: chatModel };
      }

      // Fallback: pick a fast standard-tier model
      const standardModels = this.modelManager.getModelsByTier('standard')
        .sort((a, b) => b.score - a.score);
      const lightModels = this.modelManager.getModelsByTier('light')
        .filter(m => m.parameterCount >= 3)
        .sort((a, b) => b.score - a.score);

      const best = standardModels[0] || lightModels[0];
      if (best) {
        this.modelManager.switchTo(best.name);
        this.modelManager.setAutoSwitch(false);
        this.context.setSystemPrompt(best.name);
      }
    } else {
      this.context.setSystemPrompt(this.modelManager.getCurrentModel());
    }

    return { model: this.modelManager.getCurrentModel() };
  }

  /** Detect image paths in user messages and return base64 data for vision models.
   *  Supports three forms:
   *    1. Absolute / explicit-relative paths (`/tmp/x.png`, `./x.png`, `~/x.png`).
   *    2. `@<path>` mention syntax that survived expandFileMentions
   *       (which now skips images so extractImages handles them).
   *    3. Bare filenames in cwd (`x.png`) when they exist on disk.
   */
  private async extractImages(message: string): Promise<string[]> {
    const ext = '(?:png|jpg|jpeg|gif|webp|bmp)';
    // Either a path with explicit prefix, an @-mention, or a bare filename.
    const pathPattern = new RegExp(
      `(?:^|\\s)(@?(?:(?:/|\\./|~/|[A-Za-z]:\\\\)[\\w./-]+\\.${ext}|[\\w./-]+\\.${ext}))`,
      'gi',
    );
    const matches = [...message.matchAll(pathPattern)];
    if (matches.length === 0) return [];

    const images: string[] = [];
    const seen = new Set<string>(); // dedupe paths mentioned multiple times
    for (const match of matches) {
      let filePath = match[1].trim();
      if (filePath.startsWith('@')) filePath = filePath.slice(1);
      if (filePath.startsWith('~/')) {
        filePath = resolve(process.env.HOME || '~', filePath.slice(2));
      } else {
        filePath = resolve(process.cwd(), filePath);
      }
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      if (existsSync(filePath)) {
        try {
          const data = await readFileAsync(filePath);
          images.push(data.toString('base64'));
        } catch { /* skip unreadable */ }
      }
    }
    return images;
  }

  /** Find a vision-capable model from the roster or model list */
  private findVisionModel(): string | null {
    // Check all models for vision capability
    const visionModels = this.modelManager.getAllModels()
      .filter(m => m.capabilities.includes('vision'))
      .sort((a, b) => b.score - a.score);
    return visionModels[0]?.name || null;
  }

  /** Expand @file mentions in user messages — reads the file and appends content */
  /** Expand @file mentions — searches cwd + additional dirs.
   *  Image extensions are deliberately skipped here; extractImages handles
   *  them downstream as base64 attachments. Inlining a binary file as text
   *  would corrupt the message. */
  private async expandFileMentions(message: string): Promise<string> {
    const mentionPattern = /@([\w./-]+(?:\.\w+))/g;
    const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
    const mentions = [...message.matchAll(mentionPattern)];
    if (mentions.length === 0) return message;

    const searchDirs = this.context.getSearchDirs();
    const fileContents: string[] = [];
    for (const match of mentions) {
      const ext = match[1].split('.').pop()?.toLowerCase() ?? '';
      if (imageExts.has(ext)) continue; // hand off to extractImages
      // Try each search directory until we find the file
      for (const dir of searchDirs) {
        const filePath = resolve(dir, match[1]);
        if (existsSync(filePath)) {
          try {
            const content = await readFileAsync(filePath, 'utf-8');
            const lines = content.split('\n');
            const preview = lines.length > 200
              ? lines.slice(0, 200).join('\n') + `\n... (${lines.length - 200} more lines)`
              : content;
            fileContents.push(`\n<file path="${relative(process.cwd(), filePath)}">\n${preview}\n</file>`);
            break;
          } catch { /* skip unreadable */ }
        }
      }
    }

    if (fileContents.length === 0) return message;
    return message + '\n\n' + fileContents.join('\n');
  }

  // ─── Plan Auto-Persistence ───────────────────────────────────────

  private static PLAN_DIR = '.veepee';
  private static PLAN_FILE = '.veepee/plan.md';

  private static PLAN_CONTENT_PATTERNS = [
    /^#{1,3}\s+(implementation|action)\s+plan/im,
    /^#{1,3}\s+plan\b/im,
    /^##\s+(step|phase)\s+\d/im,
    /(?:^|\n)\d+\.\s+\*\*.*\*\*.*\n\d+\.\s+\*\*/m,  // numbered bold steps
    /(?:^|\n)(?:step|phase)\s+\d+[.:]/im,
  ];

  /** Detect if assistant output contains a plan and auto-save it */
  private async autoSavePlan(content: string): Promise<boolean> {
    if (!content || content.length < 200) return false;

    const isPlan = Agent.PLAN_CONTENT_PATTERNS.some(p => p.test(content));
    if (!isPlan) return false;

    try {
      const planDir = resolve(process.cwd(), Agent.PLAN_DIR);
      const planPath = resolve(process.cwd(), Agent.PLAN_FILE);
      await mkdir(planDir, { recursive: true });
      await writeFile(planPath, `<!-- Auto-saved by VEEPEE Code — ${new Date().toISOString()} -->\n\n${content}`, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /** Load saved plan file if it exists, for injection after compaction */
  async loadSavedPlan(): Promise<string | null> {
    try {
      const planPath = resolve(process.cwd(), Agent.PLAN_FILE);
      return await readFile(planPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Detect if a message has planning intent */
  private detectPlanningIntent(message: string): boolean {
    // Don't auto-detect in chat mode
    if (this.mode === 'chat') return false;
    return PLAN_PATTERNS.some(p => p.test(message));
  }

  /** Load optimal context sizes from latest benchmark results */
  private async loadBenchmarkContextSizes(): Promise<void> {
    const latestPath = resolve(process.env.HOME || '~', '.veepee-code', 'benchmarks', 'latest.json');
    if (!existsSync(latestPath)) return;

    try {
      const data = await readFile(latestPath, 'utf-8');
      const results = JSON.parse(data) as BenchmarkResult[];
      for (const r of results) {
        if (r.context?.optimalSize) {
          this.optimalContextSizes.set(r.model, r.context.optimalSize);
        }
      }
    } catch {
      // Non-critical — use defaults
    }
  }

  /** Get the optimal num_ctx for the current model */
  private getOptimalContext(model: string): number | undefined {
    return this.optimalContextSizes.get(model);
  }

  getContext(): ContextManager {
    return this.context;
  }

  getModelManager(): ModelManager {
    return this.modelManager;
  }

  getPermissions(): PermissionManager {
    return this.permissions;
  }

  getSubAgents(): SubAgentManager {
    return this.subAgents;
  }

  setEffort(level: EffortLevel): void {
    this.effort = level;
  }

  getEffort(): EffortLevel {
    return this.effort;
  }

  /** Get Ollama options based on effort level */
  private getEffortOptions(): { num_predict?: number; temperature?: number } {
    switch (this.effort) {
      case 'low': return { num_predict: 256, temperature: 0.3 };
      case 'high': return { num_predict: 4096, temperature: 0.7 };
      case 'medium':
      default: return { num_predict: 1024, temperature: 0.5 };
    }
  }

  /** Abort the current running agent loop (called on Ctrl+C) */
  abort(): void {
    this.abortController?.abort();
  }

  isRunning(): boolean {
    return this.abortController !== null;
  }

  setModel(model: string): void {
    this.modelManager.switchTo(model);
    this.context.setSystemPrompt(model);
  }

  /** Run the agent loop for a user message, yielding events as they occur */
  async *run(
    userMessage: string,
    options?: { permissionMode?: PermissionMode; allowedTools?: string[] | null },
  ): AsyncGenerator<AgentEvent> {
    const permissionMode = options?.permissionMode || 'interactive';
    const allowedTools = options?.allowedTools ? new Set(options.allowedTools) : null;
    this.abortController = new AbortController();

    // UserPromptSubmit hook — fires on raw user input, before any expansion
    // or model interaction. Hook stdout is shown to the user; non-zero exit
    // does NOT block the run (advisory only). Lets users automate things
    // like "log every prompt" or "warn if prompt mentions production".
    yield* this._fireHooks('UserPromptSubmit', { prompt: userMessage, cwd: process.cwd() });

    // Expand @file mentions — read files and append content
    const expandedMessage = await this.expandFileMentions(userMessage);

    // Detect images in message and switch to vision model if needed
    const images = await this.extractImages(expandedMessage);
    let visionModelSwitch: string | null = null;
    if (images.length > 0) {
      const visionModel = this.findVisionModel();
      if (visionModel && visionModel !== this.modelManager.getCurrentModel()) {
        visionModelSwitch = this.modelManager.getCurrentModel(); // save to restore later
        this.modelManager.switchTo(visionModel);
        this.context.setSystemPrompt(visionModel);
        yield { type: 'model_switch', content: 'Switching to vision model for image analysis', from: visionModelSwitch, to: visionModel };
      } else if (!visionModel) {
        yield { type: 'thinking', content: 'No vision model available — image will be described by path only' };
      }
    }

    // Auto-detect planning intent and switch modes if needed
    if (this.mode === 'act' && this.detectPlanningIntent(expandedMessage)) {
      const { model } = this.enterPlanMode();
      yield { type: 'model_switch', content: `Entering plan mode (thinking enabled)`, from: this.previousModel || '', to: model };
    }

    this.context.addUser(expandedMessage);

    // Set context limit from benchmarks or model metadata
    const ctxLimit = this.getOptimalContext(this.modelManager.getCurrentModel());
    if (ctxLimit) {
      this.context.setContextLimit(ctxLimit);
    }

    // Pre-compaction snapshot: at 90%, save state to disk (costs zero tokens)
    if (this.context.isContextCritical()) {
      const existing = await this.loadSavedPlan();
      if (!existing) {
        // No plan file yet — save last assistant messages as a recovery snapshot
        const recentAssistant = this.context.getAllMessages()
          .filter(m => m.role === 'assistant' && m.content)
          .slice(-3)
          .map(m => m.content)
          .join('\n\n---\n\n');
        const ks = this.context.getKnowledgeState().serialize();
        if (recentAssistant.length > 100) {
          const snapshot = `<!-- Auto-snapshot at 90% context — ${new Date().toISOString()} -->\n\n## Knowledge State\n\n${ks}\n\n## Recent Context\n\n${recentAssistant}`;
          const planDir = resolve(process.cwd(), '.veepee');
          const planPath = resolve(process.cwd(), '.veepee/plan.md');
          await mkdir(planDir, { recursive: true }).catch(() => {});
          await writeFile(planPath, snapshot, 'utf-8').catch(() => {});
        }
      }
    }

    // Check for context compaction
    if (this.context.needsCompaction()) {
      if (this.context.compact(this.config.proxyUrl, this.modelManager.getCurrentModel())) {
        yield { type: 'thinking', content: 'Compacted conversation to free context space' };

        // Recover saved plan after compaction so the model doesn't lose it
        const savedPlan = await this.loadSavedPlan();
        if (savedPlan) {
          this.context.addUser('[System: Context was compacted. Your implementation plan from .veepee/plan.md is below — immediately execute the next incomplete step without waiting for user input]\n\n' + savedPlan);
          yield { type: 'thinking', content: 'Restored plan from .veepee/plan.md' };
        }
      }
    }

    // Stuck loop detection: track recent tool calls to detect repetition
    const recentToolCalls: string[] = [];
    const MAX_IDENTICAL_CALLS = 3;
    const MAX_TURNS_WITHOUT_OUTPUT = 15;
    let turnsWithoutUserContent = 0;

    for (let turn = 0; ; turn++) {
      // Check if model should switch (only after the first turn of a message)
      if (turn > 0) {
        const signals = this.context.getSignals();
        const newModel = this.modelManager.evaluate(signals);
        if (newModel) {
          this.context.setSystemPrompt(newModel);
          yield { type: 'model_switch', from: this.modelManager.getCurrentModel(), to: newModel };
        }
      }

      const currentModel = this.modelManager.getCurrentModel();

      // Build messages with system prompt
      const contextMessages = this.context.getMessages();
      const messages: Message[] = [
        { role: 'system', content: this.context.getSystemPrompt() },
        ...contextMessages,
      ];

      // Inject images into the last user message if present
      if (images.length > 0 && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === 'user') {
          (lastMsg as unknown as { images: string[] }).images = images;
        }
      }

      // Stall timeout: 5 minutes with no chunks = assume Ollama is hung
      // Resets on each chunk, so model loading time doesn't trigger it
      const STALL_TIMEOUT_MS = 5 * 60 * 1000;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const resetStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          this.abortController?.abort();
        }, STALL_TIMEOUT_MS);
      };

      // Stream LLM response with thinking detection
      let fullContent = '';
      let toolCalls: ToolCall[] = [];
      let inThinking = false;
      let thinkingBuffer = '';
      let evalCount = 0;
      let promptEvalCount = 0;
      let evalDuration = 0;

      try {
        // Use optimal context size from benchmarks if available
        const numCtx = this.getOptimalContext(currentModel);

        // Mode-specific settings:
        // plan: thinking ON, mutating tools FILTERED OUT, exit_plan_mode required
        // act:  thinking OFF, all tools, auto-switch model
        // chat: thinking OFF, web/search tools only, standard model
        const useThinking = this.mode === 'plan';
        let tools = this.mode === 'chat'
          ? this.registry.toOllamaTools().filter(t => {
              const name = t.function?.name || '';
              return CHAT_TOOLS.includes(name);
            })
          : this.mode === 'plan'
          ? this.registry.toOllamaTools().filter(t => {
              const name = t.function?.name || '';
              // Block mutations until exit_plan_mode is approved. Hard gate.
              return !PLAN_DISABLED_TOOLS.has(name);
            })
          : this.registry.toOllamaTools();

        // Filter tools for API requests with client-constrained tool sets
        if (allowedTools) {
          tools = tools.filter(t => allowedTools.has(t.function?.name || ''));
        }
        const effortOpts = this.getEffortOptions();

        // Retry wrapper: one retry with 3s backoff on connection errors
        const chatWithRetry = async () => {
          try {
            return await this.ollama.chat({
              model: currentModel,
              messages,
              ...(tools.length > 0 ? { tools } : {}),
              stream: true,
              think: useThinking,
              keep_alive: '30m',
              options: {
                ...(numCtx ? { num_ctx: numCtx } : {}),
                ...effortOpts,
              },
            } as never);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Retry on connection errors (not on model errors)
            if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) {
              await new Promise(r => setTimeout(r, 3000));
              return this.ollama.chat({
                model: currentModel,
                messages,
                ...(tools.length > 0 ? { tools } : {}),
                stream: true,
                think: useThinking,
                keep_alive: '30m',
                options: {
                  ...(numCtx ? { num_ctx: numCtx } : {}),
                  ...effortOpts,
                },
              } as never);
            }
            throw err;
          }
        };

        resetStallTimer();
        const stream = await chatWithRetry();

        for await (const chunk of stream) {
          resetStallTimer();

          // Check for abort
          if (this.abortController?.signal.aborted) {
            if (stallTimer) clearTimeout(stallTimer);
            yield { type: 'error', error: 'Interrupted by user' };
            this.abortController = null;
            return;
          }

          if (chunk.message.content) {
            const text = chunk.message.content;
            fullContent += text;

            // Detect <think> tags (used by Qwen, DeepSeek, etc.)
            if (!inThinking && text.includes('<think>')) {
              inThinking = true;
              // Extract any text before <think> tag
              const before = text.split('<think>')[0];
              if (before) yield { type: 'text', content: before };
              // Start thinking buffer
              thinkingBuffer = text.split('<think>').slice(1).join('<think>');
              yield { type: 'thinking', content: '...' }; // signal thinking started
              continue;
            }

            // Orphan </think>: reasoning models like Qwen3.6 (served by vLLM
            // without a reasoning parser) emit the thinking trace directly
            // into content and close it with a bare </think> before the final
            // answer. Reclassify everything streamed so far as thinking and
            // reset the TUI's stream buffer so the user only sees the answer.
            if (!inThinking && text.includes('</think>')) {
              const parts = text.split('</think>');
              const beforeClose = parts[0];
              const afterClose = parts.slice(1).join('</think>');
              // Everything streamed before this chunk, plus the portion of
              // this chunk up to the orphan close, was reasoning.
              const streamedBefore = fullContent.slice(0, fullContent.length - text.length);
              const reasoningText = (streamedBefore + beforeClose).trim();

              yield { type: 'reset_stream' };
              if (reasoningText) yield { type: 'thinking', content: reasoningText };
              if (afterClose) yield { type: 'text', content: afterClose };
              continue;
            }

            if (inThinking) {
              if (text.includes('</think>')) {
                // End of thinking block
                const parts = text.split('</think>');
                thinkingBuffer += parts[0];
                inThinking = false;

                // Yield the full thinking content (collapsed in TUI)
                yield { type: 'thinking', content: thinkingBuffer.trim() };
                thinkingBuffer = '';

                // Any text after </think> is regular output
                const after = parts.slice(1).join('</think>');
                if (after) yield { type: 'text', content: after };
              } else {
                thinkingBuffer += text;
                // Periodically update thinking indicator
                if (thinkingBuffer.length % 200 < text.length) {
                  yield { type: 'thinking', content: '...' };
                }
              }
              continue;
            }

            yield { type: 'text', content: text };
          }

          if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
            toolCalls = chunk.message.tool_calls;
          }

          // Capture eval metrics from final chunk
          const c = chunk as unknown as Record<string, number>;
          if (c.eval_count) evalCount += c.eval_count;
          if (c.prompt_eval_count) promptEvalCount += c.prompt_eval_count;
          if (c.eval_duration) evalDuration += c.eval_duration;
        }

        if (stallTimer) clearTimeout(stallTimer);

        // If thinking was still open (malformed output), flush it
        if (inThinking && thinkingBuffer) {
          yield { type: 'thinking', content: thinkingBuffer.trim() };
        }
      } catch (err) {
        if (stallTimer) clearTimeout(stallTimer);
        const wasAborted = this.abortController?.signal.aborted;
        this.abortController = null;
        if (wasAborted) {
          yield { type: 'error', error: 'Response timed out or interrupted' };
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', error: msg };
        this.context.addAssistant(`Error communicating with model: ${msg}`);
        return;
      }

      // Record actual token usage for context-aware window sizing
      if (promptEvalCount > 0) {
        this.context.recordPromptTokens(promptEvalCount);
      }

      // Add assistant message to context
      this.context.addAssistant(fullContent, toolCalls.length > 0 ? toolCalls : undefined);

      // If no tool calls, the turn is complete
      if (toolCalls.length === 0) {
        // Save knowledge state to disk (non-blocking)
        this.context.getKnowledgeState().save().catch(() => {});

        // Auto-save plans to disk so they survive compaction
        const planSaved = await this.autoSavePlan(fullContent);
        if (planSaved) {
          yield { type: 'thinking', content: 'Plan auto-saved to .veepee/plan.md' };
        }

        this.abortController = null;

        // Restore original model if we switched for vision
        if (visionModelSwitch) {
          this.modelManager.switchTo(visionModelSwitch);
          this.context.setSystemPrompt(visionModelSwitch);
        }

        const tps = evalDuration > 0 ? Math.round((evalCount / evalDuration) * 1e9) : 0;
        yield {
          type: 'done',
          evalCount,
          promptEvalCount,
          tokensPerSecond: tps,
        };
        return;
      }

      // Execute tool calls — parallelize independent read-only calls
      const READ_ONLY_TOOLS = new Set(['read_file', 'glob', 'grep', 'list_files', 'system_info', 'web_search', 'web_fetch']);

      // Check if all calls are independent read-only (safe to parallelize)
      // Note: hook plumbing for PreToolUse/PostToolUse is below in both the
      // parallel and sequential paths. See _fireHooks helper at end of class.
      const allReadOnly = toolCalls.length > 1 && toolCalls.every(c => READ_ONLY_TOOLS.has(c.function.name));

      if (allReadOnly) {
        // Parallel execution for independent read-only calls
        for (const call of toolCalls) {
          yield { type: 'tool_call', name: call.function.name, args: (call.function.arguments || {}) as Record<string, unknown> };
        }
        // Permission checks must be serialized to avoid concurrent prompt races.
        const executableCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const earlyResults: Array<{ name: string; args: Record<string, unknown>; result: { success: boolean; output: string; error?: string } }> = [];
        for (const call of toolCalls) {
          const name = call.function.name;
          const args = (call.function.arguments || {}) as Record<string, unknown>;
          if (allowedTools && !allowedTools.has(name)) {
            earlyResults.push({ name, args, result: { success: false, output: '', error: `Tool "${name}" not allowed` } });
            continue;
          }
          const decision = permissionMode === 'auto_allow'
            ? 'allow'
            : await this.permissions.check(name, args);
          if (decision === 'deny') {
            earlyResults.push({ name, args, result: { success: false, output: '', error: 'Permission denied' } });
            continue;
          }
          // PreToolUse hook — non-zero exit blocks the tool call.
          const preBlock = yield* this._fireHooks('PreToolUse', { tool: name, args, cwd: process.cwd() });
          if (preBlock.blocked) {
            earlyResults.push({ name, args, result: { success: false, output: '', error: preBlock.reason || 'Blocked by hook' } });
            continue;
          }
          executableCalls.push({ name, args });
        }
        const executed = await Promise.all(executableCalls.map(async ({ name, args }) => {
          const startedAt = Date.now();
          const result = await this.registry.execute(name, args);
          return { name, args, result, durationMs: Date.now() - startedAt };
        }));
        // Fire PostToolUse for each executed call, in order. Output is purely
        // informational here; PostToolUse cannot abort what already happened.
        for (const { name, args, result, durationMs } of executed) {
          yield* this._fireHooks('PostToolUse', { tool: name, args, cwd: process.cwd(), result, durationMs });
        }
        const results = [...earlyResults, ...executed];
        for (const { name, args, result } of results) {
          yield {
            type: 'tool_result', name,
            success: result.success,
            content: result.success ? result.output : result.error,
            error: result.error,
          };
          const resultContent = result.success ? result.output : `Error: ${result.error}`;
          this.context.addToolResult(name, resultContent, (args.path as string) || undefined);
        }
      } else {
        // Sequential execution for write/mixed calls
        for (const call of toolCalls) {
          const toolName = call.function.name;
          const toolArgs = (call.function.arguments || {}) as Record<string, unknown>;

          if (allowedTools && !allowedTools.has(toolName) && toolName !== 'update_memory') {
            yield { type: 'tool_result', name: toolName, success: false, content: `Tool "${toolName}" is not in the allowed set for this request` };
            this.context.addToolResult(toolName, `Tool "${toolName}" not allowed`);
            continue;
          }

          if (toolName === 'update_memory') {
            const key = (toolArgs.key as string) || '';
            const value = (toolArgs.value as string) || '';
            this.context.getKnowledgeState().updateMemory(key, value);
            yield { type: 'tool_result', name: toolName, success: true, content: `Stored: ${key} = ${value}` };
            this.context.addToolResult(toolName, `Stored: ${key} = ${value}`);
            continue;
          }

          yield { type: 'tool_call', name: toolName, args: toolArgs };

          const preview = this._previewToolCall(toolName, toolArgs);
          const decision = permissionMode === 'auto_allow'
            ? 'allow'
            : await this.permissions.check(toolName, toolArgs, preview);
          if (decision === 'deny') {
            yield { type: 'permission_denied', name: toolName };
            this.context.addToolResult(toolName, `Permission denied: user rejected ${toolName}`);
            continue;
          }

          // PreToolUse hook — non-zero exit blocks the tool call.
          const preBlock = yield* this._fireHooks('PreToolUse', {
            tool: toolName, args: toolArgs, cwd: process.cwd(),
          });
          if (preBlock.blocked) {
            yield {
              type: 'tool_result',
              name: toolName,
              success: false,
              content: preBlock.reason || 'Blocked by hook',
              error: preBlock.reason || 'Blocked by hook',
            };
            this.context.addToolResult(toolName, preBlock.reason || 'Blocked by hook', (toolArgs.path as string) || undefined);
            continue;
          }

          const startedAt = Date.now();
          const result = await this.registry.execute(toolName, toolArgs);
          const durationMs = Date.now() - startedAt;

          // PostToolUse hook — informational; cannot abort.
          yield* this._fireHooks('PostToolUse', {
            tool: toolName, args: toolArgs, cwd: process.cwd(), result, durationMs,
          });

          yield {
            type: 'tool_result',
            name: toolName,
            success: result.success,
            content: result.success ? result.output : result.error,
            error: result.error,
          };

          const resultContent = result.success ? result.output : `Error: ${result.error}`;
          const filePath = (toolArgs.path as string) || undefined;
          this.context.addToolResult(toolName, resultContent, filePath);
        }
      }

      // Flush knowledge state update after all tool results are collected
      this.context.flushKnowledgeUpdate(fullContent);

      // Stuck loop detection
      if (toolCalls.length > 0) {
        const callSig = toolCalls.map(c => `${c.function.name}:${JSON.stringify(c.function.arguments)}`).join('|');
        recentToolCalls.push(callSig);
        if (recentToolCalls.length > MAX_IDENTICAL_CALLS) recentToolCalls.shift();

        // Detect identical consecutive calls
        if (recentToolCalls.length >= MAX_IDENTICAL_CALLS &&
            recentToolCalls.every(c => c === recentToolCalls[0])) {
          yield { type: 'error', error: `Stopped: model called ${toolCalls[0].function.name} ${MAX_IDENTICAL_CALLS} times with identical args. It may be stuck in a loop.` };
          this.abortController = null;
          return;
        }
      }

      // Detect turns with no user-visible content
      if (!fullContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim()) {
        turnsWithoutUserContent++;
        if (turnsWithoutUserContent >= MAX_TURNS_WITHOUT_OUTPUT) {
          yield { type: 'error', error: `Stopped: ${MAX_TURNS_WITHOUT_OUTPUT} turns with no visible output. The model may be stuck.` };
          this.abortController = null;
          return;
        }
      } else {
        turnsWithoutUserContent = 0;
      }

      // Proactive compaction check after tool results (context grows most here)
      if (this.context.needsCompaction()) {
        if (this.context.compact(this.config.proxyUrl, this.modelManager.getCurrentModel())) {
          yield { type: 'thinking', content: 'Compacted conversation to free context space' };

          const savedPlan = await this.loadSavedPlan();
          if (savedPlan) {
            this.context.addUser('[System: Context was compacted. Your implementation plan from .veepee/plan.md is below — immediately execute the next incomplete step without waiting for user input]\n\n' + savedPlan);
            yield { type: 'thinking', content: 'Restored plan from .veepee/plan.md' };
          }
        }
      }
    }

    // Stop hook — fires when the assistant finishes a turn cleanly. Early
    // returns from error paths above bypass this (intentional — Stop should
    // imply a successful turn boundary, not an aborted one).
    yield* this._fireHooks('Stop', { cwd: process.cwd(), messageCount: this.context.messageCount() });
  }

  /** Compute a preview string for a tool call that mutates files. Returns
   *  undefined for tools we don't preview, or when the preview can't be
   *  computed (e.g. file doesn't exist for an edit). The preview is shown
   *  in the permission prompt so the user can approve with full context.
   */
  private _previewToolCall(toolName: string, args: Record<string, unknown>): string | undefined {
    try {
      const path = typeof args.path === 'string' ? resolve(args.path) : null;
      if (!path) return undefined;

      if (toolName === 'edit_file') {
        if (!existsSync(path)) return undefined;
        const oldContent = readFileSync(path, 'utf-8');
        const oldStr = String(args.old_string ?? '');
        const newStr = String(args.new_string ?? '');
        const replaceAll = args.replace_all === true;
        if (!oldContent.includes(oldStr)) return undefined;
        const newContent = replaceAll
          ? oldContent.split(oldStr).join(newStr)
          : oldContent.replace(oldStr, newStr);
        return previewEdit(oldContent, newContent, relative(process.cwd(), path));
      }

      if (toolName === 'write_file') {
        const newContent = typeof args.content === 'string' ? args.content : '';
        const existing = existsSync(path) ? readFileSync(path, 'utf-8') : null;
        return previewWrite(existing, newContent, relative(process.cwd(), path));
      }

      return undefined;
    } catch {
      return undefined; // never block on preview failure
    }
  }

  /** Fire all matching hooks for a lifecycle event. Yields a `hook_output`
   *  event for each hook whose stdout, stderr, or non-zero exit is worth
   *  surfacing to the user. Returns the block decision so callers can abort
   *  the action (PreToolUse semantics). For events that never block
   *  (PostToolUse, Stop, Notification, UserPromptSubmit), the return value
   *  is harmlessly ignored.
   *
   *  Use `yield* this._fireHooks(event, payload)` from the calling generator.
   */
  private async *_fireHooks(
    event: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'Notification',
    payload: Record<string, unknown>,
  ): AsyncGenerator<AgentEvent, { blocked: boolean; reason?: string }> {
    const results: HookExecResult[] = await runHooks(event, payload as never);
    for (const r of results) {
      const text = r.stdout || r.stderr;
      const blockedHere = event === 'PreToolUse' && r.exitCode !== 0;
      // Surface output only when there's something to show, the hook timed
      // out, or the hook is going to block — don't pollute the chat with
      // silent successful hooks.
      if (text || r.timedOut || blockedHere) {
        const content = r.timedOut
          ? `[hook ${event}] timed out: ${r.hook.command}`
          : (text || `[hook ${event}] exited ${r.exitCode}`);
        yield {
          type: 'hook_output',
          content,
          hookEvent: event,
          hookLayer: r.layer,
          hookExitCode: r.exitCode,
          hookBlocked: blockedHere,
        };
      }
    }
    return shouldBlock(results);
  }

  /** Non-streaming version for API use (no permission prompts — auto-allows) */
  async runSync(
    userMessage: string,
    options?: { permissionMode?: PermissionMode; allowedTools?: string[] | null },
  ): Promise<{ content: string; toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }> }> {
    let content = '';
    const toolCallResults: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];

    for await (const event of this.run(userMessage, options)) {
      switch (event.type) {
        case 'text':
          content += event.content || '';
          break;
        case 'tool_result':
          toolCallResults.push({
            name: event.name || '',
            args: event.args || {},
            result: event.content || event.error || '',
          });
          break;
      }
    }

    return { content, toolCalls: toolCallResults };
  }

  clear(): void {
    this.context.clear();
    this.context.setSystemPrompt(this.modelManager.getCurrentModel());
  }
}
