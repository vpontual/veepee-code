import { Ollama } from 'ollama';
import type { Message, ToolCall } from 'ollama';
import type { Config } from './config.js';
import type { ToolRegistry } from './tools/registry.js';
import type { PermissionManager } from './permissions.js';
import type { BenchmarkResult } from './benchmark.js';
import { ContextManager } from './context.js';
import { ModelManager } from './models.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { existsSync } from 'fs';

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'model_switch' | 'thinking' | 'done' | 'error' | 'permission_denied';
  content?: string;
  name?: string;
  args?: Record<string, unknown>;
  success?: boolean;
  error?: string;
  from?: string;
  to?: string;
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

export class Agent {
  private ollama: Ollama;
  private context: ContextManager;
  private modelManager: ModelManager;
  private registry: ToolRegistry;
  private permissions: PermissionManager;
  private maxTurns: number;
  private optimalContextSizes = new Map<string, number>();
  private mode: AgentMode = 'act';
  private previousModel: string | null = null; // to restore after plan mode

  constructor(config: Config, registry: ToolRegistry, modelManager: ModelManager, permissions: PermissionManager) {
    this.ollama = new Ollama({ host: config.proxyUrl });
    this.context = new ContextManager();
    this.modelManager = modelManager;
    this.registry = registry;
    this.permissions = permissions;
    this.maxTurns = config.maxTurns;

    // Load benchmark results for optimal context sizes
    this.loadBenchmarkContextSizes();
  }

  getMode(): AgentMode {
    return this.mode;
  }

  /** Enter plan mode — thinking ON, heavy model, no auto-switch */
  enterPlanMode(): { model: string } {
    this.mode = 'plan';
    this.previousModel = this.modelManager.getCurrentModel();

    // Switch to the best heavy model with thinking support
    const heavyModels = this.modelManager.getModelsByTier('heavy')
      .filter(m => m.capabilities.includes('tools'))
      .sort((a, b) => b.score - a.score);

    // Prefer models with thinking capability
    const thinker = heavyModels.find(m => m.capabilities.includes('thinking'));
    const best = thinker || heavyModels[0];

    if (best && best.name !== this.modelManager.getCurrentModel()) {
      this.modelManager.switchTo(best.name);
      this.modelManager.setAutoSwitch(false); // lock model during planning
      this.context.setSystemPrompt(best.name);
    }

    this.context.setMode('plan');

    return { model: this.modelManager.getCurrentModel() };
  }

  /** Exit plan/chat mode — restore previous model and settings */
  exitPlanMode(): void {
    this.mode = 'act';
    this.context.setMode('act');

    if (this.previousModel) {
      this.modelManager.switchTo(this.previousModel);
      this.previousModel = null;
    }
    this.modelManager.setAutoSwitch(true);
    this.context.setSystemPrompt(this.modelManager.getCurrentModel());
  }

  /** Enter chat mode — web tools only, lighter model, fast conversation */
  enterChatMode(): { model: string } {
    this.mode = 'chat';
    this.previousModel = this.modelManager.getCurrentModel();
    this.context.setMode('chat');

    // Pick a fast standard-tier model
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

    return { model: this.modelManager.getCurrentModel() };
  }

  /** Detect if a message has planning intent */
  private detectPlanningIntent(message: string): boolean {
    // Don't auto-detect in chat mode
    if (this.mode === 'chat') return false;
    return PLAN_PATTERNS.some(p => p.test(message));
  }

  /** Load optimal context sizes from latest benchmark results */
  private async loadBenchmarkContextSizes(): Promise<void> {
    const latestPath = resolve(process.env.HOME || '~', '.llama-code', 'benchmarks', 'latest.json');
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

  setModel(model: string): void {
    this.modelManager.switchTo(model);
    this.context.setSystemPrompt(model);
  }

  /** Run the agent loop for a user message, yielding events as they occur */
  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    // Auto-detect planning intent and switch modes if needed
    if (this.mode === 'act' && this.detectPlanningIntent(userMessage)) {
      const { model } = this.enterPlanMode();
      yield { type: 'model_switch', content: `Entering plan mode (thinking enabled)`, from: this.previousModel || '', to: model };
    }

    this.context.addUser(userMessage);

    // Check for context compaction
    if (this.context.compact()) {
      yield { type: 'thinking', content: 'Compacted conversation to free context space' };
    }

    for (let turn = 0; turn < this.maxTurns; turn++) {
      // Check if model should switch
      const signals = this.context.getSignals();
      const newModel = this.modelManager.evaluate(signals);
      if (newModel) {
        this.context.setSystemPrompt(newModel);
        yield { type: 'model_switch', from: this.modelManager.getCurrentModel(), to: newModel };
      }

      const currentModel = this.modelManager.getCurrentModel();

      // Build messages with system prompt
      const messages: Message[] = [
        { role: 'system', content: this.context.getSystemPrompt() },
        ...this.context.getMessages(),
      ];

      // Stream LLM response with thinking detection
      let fullContent = '';
      let toolCalls: ToolCall[] = [];
      let inThinking = false;
      let thinkingBuffer = '';

      try {
        // Use optimal context size from benchmarks if available
        const numCtx = this.getOptimalContext(currentModel);

        // Mode-specific settings:
        // plan: thinking ON, all tools, heavy model
        // act:  thinking OFF, all tools, auto-switch model
        // chat: thinking OFF, web/search tools only, standard model
        const useThinking = this.mode === 'plan';
        const tools = this.mode === 'chat'
          ? this.registry.toOllamaTools().filter(t => {
              const name = t.function?.name || '';
              return ['web_search', 'web_fetch', 'http_request', 'weather', 'news'].includes(name);
            })
          : this.registry.toOllamaTools();
        const stream = await this.ollama.chat({
          model: currentModel,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          stream: true,
          think: useThinking,
          ...(numCtx ? { options: { num_ctx: numCtx } } : {}),
        } as never);

        for await (const chunk of stream) {
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
        }

        // If thinking was still open (malformed output), flush it
        if (inThinking && thinkingBuffer) {
          yield { type: 'thinking', content: thinkingBuffer.trim() };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', error: msg };
        this.context.addAssistant(`Error communicating with model: ${msg}`);
        return;
      }

      // Add assistant message to context
      this.context.addAssistant(fullContent, toolCalls.length > 0 ? toolCalls : undefined);

      // If no tool calls, the turn is complete
      if (toolCalls.length === 0) {
        yield { type: 'done' };
        return;
      }

      // Execute tool calls with permission checks
      for (const call of toolCalls) {
        const toolName = call.function.name;
        const toolArgs = (call.function.arguments || {}) as Record<string, unknown>;

        yield { type: 'tool_call', name: toolName, args: toolArgs };

        // Permission check
        const decision = await this.permissions.check(toolName, toolArgs);
        if (decision === 'deny') {
          yield { type: 'permission_denied', name: toolName };
          this.context.addToolResult(toolName, `Permission denied: user rejected ${toolName}`);
          continue;
        }

        const result = await this.registry.execute(toolName, toolArgs);

        yield {
          type: 'tool_result',
          name: toolName,
          success: result.success,
          content: result.success ? result.output : result.error,
          error: result.error,
        };

        const resultContent = result.success
          ? result.output
          : `Error: ${result.error}`;
        this.context.addToolResult(toolName, resultContent);
      }
    }

    yield { type: 'error', error: `Reached maximum turns (${this.maxTurns})` };
  }

  /** Non-streaming version for API use (no permission prompts — auto-allows) */
  async runSync(userMessage: string): Promise<{ content: string; toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }> }> {
    let content = '';
    const toolCallResults: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];

    for await (const event of this.run(userMessage)) {
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
