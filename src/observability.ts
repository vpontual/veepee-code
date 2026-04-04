/**
 * Observability — optional Langfuse integration
 *
 * When langfuse.secretKey and langfuse.publicKey are set in config,
 * each agent turn is logged as a trace: model, mode, tokens, tool calls, latency.
 *
 * This module is completely non-critical — all errors are silently swallowed.
 * The main agent loop must never be affected by observability failures.
 */

import type { Config } from './config.js';
import type { AgentMode } from './agent.js';

export interface TurnMetrics {
  sessionId: string;
  model: string;
  mode: AgentMode;
  userMessage: string;
  assistantMessage: string;
  evalCount: number;
  promptEvalCount: number;
  tokensPerSecond: number;
  latencyMs: number;
  toolCalls: Array<{ name: string; success: boolean }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LangfuseInstance = any;

export class ObservabilityManager {
  private langfuse: LangfuseInstance = null;
  private enabled = false;

  constructor(config: Config) {
    const lf = config.langfuse;
    if (!lf?.secretKey || !lf?.publicKey) return;

    // Lazy init — don't block startup
    import('langfuse').then(({ Langfuse }) => {
      this.langfuse = new Langfuse({
        secretKey: lf.secretKey,
        publicKey: lf.publicKey,
        baseUrl: lf.host,
        flushInterval: 5000,
      });
      this.enabled = true;
    }).catch(() => {
      // langfuse not installed or init failed — stay disabled
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async logTurn(metrics: TurnMetrics): Promise<void> {
    if (!this.langfuse) return;
    try {
      const trace = this.langfuse.trace({
        name: 'agent-turn',
        sessionId: metrics.sessionId,
        metadata: {
          model: metrics.model,
          mode: metrics.mode,
          cwd: process.cwd(),
        },
      });

      trace.generation({
        name: 'llm-response',
        model: metrics.model,
        input: [{ role: 'user', content: metrics.userMessage }],
        output: { role: 'assistant', content: metrics.assistantMessage },
        usage: {
          input: metrics.promptEvalCount,
          output: metrics.evalCount,
        },
        metadata: {
          tokensPerSecond: metrics.tokensPerSecond,
          latencyMs: metrics.latencyMs,
          toolCalls: metrics.toolCalls,
        },
      });

      // Non-blocking flush
      this.langfuse.flushAsync?.().catch(() => {});
    } catch { /* non-critical */ }
  }

  /** Call on process exit to ensure in-flight events are sent */
  async flush(): Promise<void> {
    if (!this.langfuse) return;
    try {
      await this.langfuse.flushAsync?.();
    } catch { /* non-critical */ }
  }
}
