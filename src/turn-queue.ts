/**
 * Serialise turns so exactly one generation is ever in flight.
 *
 * `Agent.run()` already refuses a second concurrent turn — it throws
 * AgentBusyError. That is the right guarantee and the wrong ergonomics for a
 * remote client: a message sent from the phone while the laptop is mid-turn
 * came back as an error, and the only recovery was for the person holding the
 * phone to watch the transcript and try again at the right moment.
 *
 * Queueing is the whole difference between "one at a time" and "one at a time,
 * and I will hold your place". The GPU profile is unchanged — still exactly one
 * generation — which matters here because the box is a single DGX Spark whose
 * throughput advantage comes from MTP speculative decoding, and that advantage
 * is largest at batch size 1. Running two turns at once would not just be
 * risky on a box with a history of wedging under concurrency; it would make
 * both turns slower than running them in sequence.
 *
 * SCOPE, stated honestly: this serialises turns that go THROUGH it. Parallel
 * subagents (SubAgentManager.parallel) issue their own generations and do not
 * pass through here, so they remain a separate source of concurrency. Routing
 * them through this queue would deadlock — a parent holds the slot for the
 * whole turn, including while awaiting the subagent that would be waiting for
 * the same slot.
 */

export interface QueueState {
  /** A turn is currently running. */
  running: boolean;
  /** Turns waiting behind the running one. */
  waiting: number;
}

export class TurnQueue {
  private running = false;
  private readonly waiters: Array<() => void> = [];
  private readonly listeners = new Set<(state: QueueState) => void>();

  get state(): QueueState {
    return { running: this.running, waiting: this.waiters.length };
  }

  /** Notified whenever a turn starts, finishes, or joins the queue. */
  onChange(listener: (state: QueueState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.state;
    for (const l of this.listeners) {
      try { l(snapshot); } catch { /* a bad listener must not stall the queue */ }
    }
  }

  private acquire(): Promise<void> {
    if (!this.running) {
      this.running = true;
      this.emit();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.emit();
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Stay `running` across the handoff: dropping it, even briefly, would let
      // a caller arriving in that window jump the queue.
      next();
    } else {
      this.running = false;
    }
    this.emit();
  }

  /**
   * Wait for the queue, then yield the generator through.
   *
   * `body` is not called until the slot is free, so nothing the agent does —
   * adding the user message to context, taking a checkpoint — happens for a
   * turn that is still waiting.
   *
   * The release is in a finally, so abandoning the stream (a `break` in the
   * consumer's for-await, which calls .return()) frees the slot just as a
   * normal completion does. Without that, one aborted turn would wedge every
   * turn after it.
   */
  async *stream<T>(body: () => AsyncGenerator<T>): AsyncGenerator<T> {
    await this.acquire();
    try {
      yield* body();
    } finally {
      this.release();
    }
  }

  /** Same contract for a plain promise. */
  async run<T>(body: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await body();
    } finally {
      this.release();
    }
  }
}
