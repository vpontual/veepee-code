import { describe, it, expect } from 'vitest';
import { SessionRegistry, MAX_LIVE_SESSIONS } from '../src/session-registry.js';
import type { Agent } from '../src/agent.js';

/** Just enough Agent for the registry: it only ever asks whether one is running. */
function fakeAgent(running = false): Agent {
  return { isRunning: () => running } as unknown as Agent;
}

function registry(opts: { running?: () => boolean } = {}) {
  let made = 0;
  let clock = 0;
  const created: Agent[] = [];
  const reg = new SessionRegistry(
    () => { made++; const a = fakeAgent(opts.running?.() ?? false); created.push(a); return a; },
    () => ++clock,
  );
  return { reg, created, count: () => made };
}

describe('SessionRegistry', () => {
  it('creates an agent on first use and reuses it after', () => {
    const { reg, count } = registry();
    const a = reg.get('phone');
    const b = reg.get('phone');
    expect(a).toBe(b);
    expect(count()).toBe(1);
  });

  it('gives different ids different agents', () => {
    const { reg, count } = registry();
    // The whole point: the phone's conversation is not the laptop's.
    expect(reg.get('phone')).not.toBe(reg.get('tui'));
    expect(count()).toBe(2);
  });

  it('reports ids least-recently-used first', () => {
    const { reg } = registry();
    reg.get('a'); reg.get('b'); reg.get('c');
    reg.get('a');                      // touch a, so b is now oldest
    expect(reg.ids).toEqual(['b', 'c', 'a']);
  });

  it('releases a session', () => {
    const { reg } = registry();
    reg.get('gone');
    expect(reg.has('gone')).toBe(true);
    expect(reg.release('gone')).toBe(true);
    expect(reg.has('gone')).toBe(false);
    expect(reg.release('gone')).toBe(false);
  });

  it('evicts the least recently used once full', () => {
    const { reg } = registry();
    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) reg.get(`s${i}`);
    expect(reg.size).toBe(MAX_LIVE_SESSIONS);

    reg.get('s0');            // s1 is now the oldest
    reg.get('new');
    expect(reg.has('s1')).toBe(false);
    expect(reg.has('s0')).toBe(true);
    expect(reg.has('new')).toBe(true);
    expect(reg.size).toBe(MAX_LIVE_SESSIONS);
  });

  it('never evicts an agent that is mid-turn', () => {
    // Dropping the reference would not stop the run, it would orphan the
    // stream — which is the shape of the thing that has wedged vLLM here.
    const { reg } = registry({ running: () => true });
    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) reg.get(`busy${i}`);
    reg.get('overflow');

    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) expect(reg.has(`busy${i}`)).toBe(true);
    // Going one over is the lesser evil, and is deliberate.
    expect(reg.size).toBe(MAX_LIVE_SESSIONS + 1);
  });

  it('evicts the oldest IDLE one when some are busy', () => {
    let busy = true;
    const reg = new SessionRegistry(
      // `mine` must be captured per creation — closing over the shared counter
      // makes every agent report the LAST index, so they all look idle.
      (() => { let n = 0; return () => { const mine = ++n; return { isRunning: () => (mine === 1 ? busy : false) } as unknown as Agent; }; })(),
      (() => { let c = 0; return () => ++c; })(),
    );
    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) reg.get(`s${i}`);
    reg.get('new');

    expect(reg.has('s0')).toBe(true);   // busy, skipped
    expect(reg.has('s1')).toBe(false);  // oldest idle, evicted
    busy = false;
  });
});
