import type { Agent } from './agent.js';

/**
 * Live agents, so a remote client can hold its own conversation.
 *
 * Until now there was exactly one Agent in the process, and the phone shared it
 * with the TUI: sending from the phone continued whatever the laptop was in the
 * middle of, and `/clear` from either wiped both. That is fine when RC is a
 * remote control for the laptop, and wrong the moment it is a way to actually
 * work from somewhere else.
 *
 * WHAT THIS DOES NOT DO — and cannot, yet. Every filesystem tool resolves paths
 * against `process.cwd()`, which is process-global; it is why harness-eval has
 * to chdir into each scratch workspace and run tasks strictly one at a time.
 * So sessions here share ONE working directory and differ only in conversation
 * state. Threads across different repos need cwd threaded through every
 * path-resolving tool, which is a separate and much larger change.
 *
 * Bounded on purpose: each live agent holds a full context window, and an
 * unbounded map keyed by whatever a client sends is a memory leak with a
 * network-facing key.
 */
export const MAX_LIVE_SESSIONS = 4;

interface Entry {
  agent: Agent;
  lastUsed: number;
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();

  /**
   * @param create Builds a fresh Agent. Injected rather than imported so this
   *   stays testable without the whole config/registry/model stack.
   * @param now Clock, injectable so eviction order is deterministic in tests
   *   rather than dependent on how fast the machine runs.
   */
  constructor(
    private readonly create: () => Agent,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** Ids, least recently used first. */
  get ids(): string[] {
    return [...this.entries.entries()]
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .map(([id]) => id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** The agent for `id`, created on first use. Touches its recency. */
  get(id: string): Agent {
    const existing = this.entries.get(id);
    if (existing) {
      existing.lastUsed = this.now();
      return existing.agent;
    }

    this.evictIfFull();
    const agent = this.create();
    this.entries.set(id, { agent, lastUsed: this.now() });
    return agent;
  }

  /** Drop a session. Returns whether there was one. */
  release(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * Make room, never evicting something mid-turn.
   *
   * A running agent is holding a stream and, quite possibly, a generation slot;
   * dropping our reference would not stop it, it would just orphan it — which
   * is exactly the abandoned stream that has wedged this fleet's vLLM before.
   * If everything is busy the map is allowed over its limit rather than doing
   * something destructive, since being one agent over is a smaller problem.
   */
  private evictIfFull(): void {
    if (this.entries.size < MAX_LIVE_SESSIONS) return;
    for (const id of this.ids) {
      const entry = this.entries.get(id);
      if (entry && !entry.agent.isRunning()) {
        this.entries.delete(id);
        return;
      }
    }
  }
}
