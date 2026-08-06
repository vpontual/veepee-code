import { describe, it, expect } from 'vitest';
import { GenerationLimiter } from '../src/generation-limit.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A fake streaming chat: resolves fast, then yields for a while — like the real one. */
function fakeStream(log: string[], name: string, chunks = 2) {
  return async () => {
    log.push(`${name}:open`);
    return (async function* () {
      for (let i = 0; i < chunks; i++) { await tick(); yield `${name}:${i}`; }
      log.push(`${name}:close`);
    })();
  };
}

const drain = async (gen: AsyncGenerator<string>) => { for await (const _ of gen) { void _; } };

describe('GenerationLimiter', () => {
  it('serialises two calls on the same model', async () => {
    const lim = new GenerationLimiter();
    const log: string[] = [];
    await Promise.all([
      drain(lim.stream('35b', fakeStream(log, 'a'))),
      drain(lim.stream('35b', fakeStream(log, 'b'))),
    ]);
    // The second must not open until the first has closed.
    expect(log).toEqual(['a:open', 'a:close', 'b:open', 'b:close']);
  });

  it('runs different models at the same time', async () => {
    const lim = new GenerationLimiter();
    const log: string[] = [];
    await Promise.all([
      drain(lim.stream('35b', fakeStream(log, 'dgx'))),
      drain(lim.stream('gemma4:26b-a4b', fakeStream(log, 'agx'))),
    ]);
    // Different boxes — serialising these would throw away the fleet.
    expect(log.slice(0, 2).sort()).toEqual(['agx:open', 'dgx:open']);
  });

  it('holds the slot for the whole stream, not just the promise', async () => {
    const lim = new GenerationLimiter();
    const log: string[] = [];
    const first = lim.stream('35b', fakeStream(log, 'a', 5));

    // Start consuming, then check a competing call cannot start mid-stream.
    const it = first[Symbol.asyncIterator]();
    await it.next();
    expect(lim.active).toEqual(['35b']);

    let started = false;
    const second = (async () => { await drain(lim.stream('35b', fakeStream(log, 'b'))); started = true; })();
    await tick();
    expect(started).toBe(false);
    expect(lim.waiting('35b')).toBe(1);

    await drain(it as AsyncGenerator<string>);
    await second;
    expect(lim.active).toEqual([]);
  });

  it('releases when a consumer abandons the stream', async () => {
    const lim = new GenerationLimiter();
    const log: string[] = [];
    // The agent loop returns out of its for-await on every abort, which calls
    // .return() on the iterator — the finally must still fire.
    for await (const _ of lim.stream('35b', fakeStream(log, 'aborted', 5))) { void _; break; }
    expect(lim.active).toEqual([]);

    await drain(lim.stream('35b', fakeStream(log, 'after')));
    expect(log).toContain('after:close');
  });

  it('releases when the call throws', async () => {
    const lim = new GenerationLimiter();
    await expect(lim.run('35b', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lim.active).toEqual([]);
  });

  it('releases when the stream throws mid-body', async () => {
    const lim = new GenerationLimiter();
    const bad = async () => (async function* (): AsyncGenerator<string> {
      yield 'one';
      throw new Error('mid-stream');
    })();
    await expect(drain(lim.stream('35b', bad))).rejects.toThrow('mid-stream');
    expect(lim.active).toEqual([]);
  });

  it('keeps arrival order for several waiters on one model', async () => {
    const lim = new GenerationLimiter();
    const log: string[] = [];
    const runs = [drain(lim.stream('35b', fakeStream(log, '1', 3)))];
    await tick();
    for (const n of ['2', '3']) runs.push(drain(lim.stream('35b', fakeStream(log, n))));
    await Promise.all(runs);
    expect(log.filter((l) => l.endsWith(':open'))).toEqual(['1:open', '2:open', '3:open']);
  });

  it('does not hold the slot between generations', async () => {
    // The parent releases before running tools, which is what lets a subagent
    // generate during the parent's turn instead of deadlocking behind it.
    const lim = new GenerationLimiter();
    const log: string[] = [];
    await drain(lim.stream('35b', fakeStream(log, 'parent-turn-1')));
    expect(lim.active).toEqual([]);
    await drain(lim.stream('35b', fakeStream(log, 'subagent')));
    expect(lim.active).toEqual([]);
  });
});
