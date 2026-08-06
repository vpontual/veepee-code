import { describe, it, expect } from 'vitest';
import { TurnQueue, type QueueState } from '../src/turn-queue.js';

/** A generator that reports when it starts and finishes, and can be held open. */
function tracked(log: string[], name: string, gate?: Promise<void>) {
  return async function* () {
    log.push(`${name}:start`);
    if (gate) await gate;
    yield `${name}:a`;
    yield `${name}:b`;
    log.push(`${name}:end`);
  };
}

const drain = async (gen: AsyncGenerator<string>) => { for await (const _ of gen) { void _; } };

describe('TurnQueue', () => {
  it('runs a lone turn immediately', async () => {
    const q = new TurnQueue();
    const log: string[] = [];
    await drain(q.stream(tracked(log, 'a')));
    expect(log).toEqual(['a:start', 'a:end']);
    expect(q.state).toEqual({ running: false, waiting: 0 });
  });

  it('does not start a second turn until the first finishes', async () => {
    const q = new TurnQueue();
    const log: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });

    const first = drain(q.stream(tracked(log, 'first', gate)));
    // Let the first turn reach its gate.
    await Promise.resolve();
    const second = drain(q.stream(tracked(log, 'second')));
    await Promise.resolve();

    // The second body must not have been invoked at all — nothing it does,
    // including adding a message to context, may happen while it is waiting.
    expect(log).toEqual(['first:start']);
    expect(q.state.waiting).toBe(1);

    open();
    await Promise.all([first, second]);
    expect(log).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('preserves arrival order across several waiters', async () => {
    const q = new TurnQueue();
    const log: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });

    const runs = [drain(q.stream(tracked(log, '1', gate)))];
    await Promise.resolve();
    for (const n of ['2', '3', '4']) runs.push(drain(q.stream(tracked(log, n))));
    await Promise.resolve();
    expect(q.state.waiting).toBe(3);

    open();
    await Promise.all(runs);
    expect(log.filter((l) => l.endsWith(':start'))).toEqual(['1:start', '2:start', '3:start', '4:start']);
  });

  it('frees the slot when a consumer abandons the stream', async () => {
    const q = new TurnQueue();
    const log: string[] = [];

    // `break` calls the generator's .return(), which must run the finally.
    for await (const _ of q.stream(tracked(log, 'abandoned'))) { void _; break; }
    expect(q.state).toEqual({ running: false, waiting: 0 });

    await drain(q.stream(tracked(log, 'after')));
    expect(log).toContain('after:end');
  });

  it('frees the slot when a turn throws', async () => {
    const q = new TurnQueue();
    const boom = async function* (): AsyncGenerator<string> { throw new Error('boom'); };

    await expect(drain(q.stream(boom))).rejects.toThrow('boom');
    expect(q.state).toEqual({ running: false, waiting: 0 });

    const log: string[] = [];
    await drain(q.stream(tracked(log, 'after')));
    expect(log).toEqual(['after:start', 'after:end']);
  });

  it('never reports two turns running at once', async () => {
    const q = new TurnQueue();
    const seen: QueueState[] = [];
    q.onChange((s) => seen.push(s));

    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const log: string[] = [];
    const a = drain(q.stream(tracked(log, 'a', gate)));
    await Promise.resolve();
    const b = drain(q.stream(tracked(log, 'b')));
    await Promise.resolve();
    open();
    await Promise.all([a, b]);

    // `running` is a boolean, so the invariant is that it is never observed
    // false while a waiter still exists — that would be a slot going unclaimed.
    expect(seen.some((s) => !s.running && s.waiting > 0)).toBe(false);
    expect(seen[seen.length - 1]).toEqual({ running: false, waiting: 0 });
  });

  it('serialises plain promises too', async () => {
    const q = new TurnQueue();
    const log: string[] = [];
    const task = (name: string, ms: number) => () =>
      new Promise<void>((r) => setTimeout(() => { log.push(name); r(); }, ms));

    await Promise.all([q.run(task('slow', 20)), q.run(task('fast', 0))]);
    expect(log).toEqual(['slow', 'fast']);
  });
});
