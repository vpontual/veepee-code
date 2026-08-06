/**
 * At most one generation per model at a time.
 *
 * [[turn-queue.ts]] serialises TURNS, which covers the TUI, the API and the
 * phone contending for the agent. It does not cover subagents: a background
 * `task` keeps generating while its parent carries on, and
 * SubAgentManager.parallel fans out several at once. On this fleet that means
 * two or more generations landing on the same box simultaneously.
 *
 * Why that matters here specifically: the DGX Spark's throughput comes from MTP
 * speculative decoding, which pays off most at batch size 1 — concurrent
 * generations make BOTH slower than running them in sequence — and this box has
 * a history of wedging under concurrent streaming.
 *
 * KEYED BY MODEL, NOT GLOBALLY. A model maps to a box on this fleet: the 35B is
 * the DGX, gemma4:26b-a4b the AGX, qwen3:8b Nano 1. Two subagents on different
 * models are two different GPUs and should absolutely run at once — serialising
 * those would throw away the fleet. Only same-model calls contend.
 *
 * NOT A TURN LOCK. The slot is held for the duration of a single generation and
 * released before tools run, so a parent never holds it while awaiting a
 * subagent that needs it. That is what makes this safe to apply to parent and
 * subagent alike, where the turn queue would deadlock.
 */

type Release = () => void;

export class GenerationLimiter {
  private readonly busy = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  /** Models currently generating. Exposed for diagnostics and tests. */
  get active(): string[] {
    return [...this.busy].sort();
  }

  /** How many calls are waiting on `model`. */
  waiting(model: string): number {
    return this.waiters.get(model)?.length ?? 0;
  }

  async acquire(model: string): Promise<Release> {
    if (!this.busy.has(model)) {
      this.busy.add(model);
      return () => this.release(model);
    }
    await new Promise<void>((resolve) => {
      const queue = this.waiters.get(model) ?? [];
      queue.push(resolve);
      this.waiters.set(model, queue);
    });
    return () => this.release(model);
  }

  private release(model: string): void {
    const queue = this.waiters.get(model);
    const next = queue?.shift();
    if (next) {
      // Stay marked busy across the handoff, or a call arriving in the gap
      // would take a slot that is already promised.
      next();
      return;
    }
    this.waiters.delete(model);
    this.busy.delete(model);
  }

  /** Hold a slot for one awaited call. */
  async run<T>(model: string, body: () => Promise<T>): Promise<T> {
    const release = await this.acquire(model);
    try {
      return await body();
    } finally {
      release();
    }
  }

  /**
   * Hold a slot for as long as a stream is being consumed.
   *
   * A streaming chat resolves its promise as soon as headers arrive — the GPU
   * is busy for the whole body after that, so releasing on the promise would
   * measure the wrong thing entirely.
   *
   * `body` is invoked only once the slot is held. The returned generator
   * releases in a finally, which JavaScript runs on normal completion, on a
   * throw, and on `.return()` — the last being what happens when a consumer
   * breaks or returns out of its `for await`, which the agent loop does on
   * every abort.
   */
  async *stream<T>(model: string, body: () => Promise<AsyncIterable<T>>): AsyncGenerator<T> {
    const release = await this.acquire(model);
    try {
      yield* await body();
    } finally {
      release();
    }
  }
}

/**
 * The process-wide limiter.
 *
 * Shared deliberately: a parent agent and the subagents it spawns are separate
 * objects, and the whole point is that they contend for the same GPU.
 */
export const generationLimiter = new GenerationLimiter();
