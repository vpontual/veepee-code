import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { report, whileBlocked, _resetForTests } from '../src/agentstate.js';

/**
 * Agent-state reporting exists so an unattended vcode that has stopped for a
 * permission prompt is DISTINGUISHABLE from one that is thinking hard — from the
 * outside, they look identical, so nothing can tell you.
 *
 * These tests pin the three properties that make it trustworthy:
 *   1. it never throws into the caller (observability must not break a session),
 *   2. it never chatters (a duplicate report is dropped),
 *   3. `blocked` always clears — including on rejection and on throw. A stuck
 *      `blocked` claim is worse than none: every supervisor watching keeps
 *      believing a session needs a human when it doesn't.
 *
 * The compositor socket is absent in the test environment, which is itself the
 * common case worth covering (vcode outside veepOS): the reporter must degrade to
 * a no-op rather than error.
 */

/** Capture the OSC 2 title writes the reporter emits on stdout. */
function captureTitles(): { titles: string[]; restore: () => void } {
  const titles: string[] = [];
  const originalTTY = process.stdout.isTTY;
  const originalTerm = process.env.TERM;
  // Pretend we're on a real terminal so the title path is exercised.
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  process.env.TERM = 'xterm-256color';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    const s = String(chunk);
    // eslint-disable-next-line no-control-regex
    const m = /\x1b\]2;(.*?)\x07/.exec(s);
    if (m) titles.push(m[1]);
    return true;
  }) as typeof process.stdout.write);
  return {
    titles,
    restore: () => {
      spy.mockRestore();
      Object.defineProperty(process.stdout, 'isTTY', { value: originalTTY, configurable: true });
      if (originalTerm === undefined) delete process.env.TERM;
      else process.env.TERM = originalTerm;
    },
  };
}

describe('agent state reporting', () => {
  let cap: ReturnType<typeof captureTitles>;
  const savedSocket = process.env.VEEWM_SOCKET;

  beforeEach(() => {
    _resetForTests();
    // Point at a path that cannot exist, so the compositor leg is a clean miss
    // instead of writing into whatever socket the dev box happens to have.
    process.env.VEEWM_SOCKET = '/nonexistent/veewm-test.sock';
    cap = captureTitles();
  });

  afterEach(() => {
    cap.restore();
    if (savedSocket === undefined) delete process.env.VEEWM_SOCKET;
    else process.env.VEEWM_SOCKET = savedSocket;
  });

  it('writes a title that survives truncation and never throws without a compositor', () => {
    expect(() => report('working')).not.toThrow();
    expect(cap.titles).toHaveLength(1);
    // Identity is front-loaded because a tab strip truncates the END of a title.
    expect(cap.titles[0]).toMatch(/^vcode /);
    expect(cap.titles[0]).toContain('working');
  });

  it('drops a duplicate report but not a changed one', () => {
    report('working');
    report('working');
    expect(cap.titles).toHaveLength(1);
    report('idle');
    expect(cap.titles).toHaveLength(2);
    // Same state, different message ⇒ still a report (the message is context the
    // `agent-state` query serves, even though veeWM emits no event for it).
    report('idle', 'waiting');
    expect(cap.titles).toHaveLength(3);
    expect(cap.titles[2]).toContain('waiting');
  });

  it('carries the reason for a blocked state so a human knows what is being asked', () => {
    report('blocked', 'approve: bash (rm -rf)');
    expect(cap.titles[0]).toContain('blocked');
    expect(cap.titles[0]).toContain('approve: bash');
  });

  it('strips control characters out of a message', () => {
    // A message is derived from tool names and shell commands, so it must not be
    // able to inject further escape sequences into the terminal's title.
    report('blocked', 'approve: bash\x1b]0;pwned\x07');
    expect(cap.titles[0]).not.toContain('\x1b');
    expect(cap.titles[0]).toContain('approve: bash');
  });

  describe('whileBlocked', () => {
    it('reports blocked then returns to working, and passes the value through', async () => {
      const answer = await whileBlocked('approve: edit_file', async () => 'y');
      expect(answer).toBe('y');
      expect(cap.titles.map(t => (t.includes('blocked') ? 'blocked' : 'working'))).toEqual([
        'blocked',
        'working',
      ]);
    });

    it('clears blocked even when the prompt throws', async () => {
      // The load-bearing case: a prompt that aborts (Ctrl-C) or throws must not
      // leave vcode advertising "needs a human" forever.
      await expect(
        whileBlocked('approve: bash', async () => {
          throw new Error('user aborted');
        }),
      ).rejects.toThrow('user aborted');
      expect(cap.titles).toHaveLength(2);
      expect(cap.titles[1]).toContain('working');
      expect(cap.titles[1]).not.toContain('blocked');
    });

    it('clears blocked when the user denies', async () => {
      const answer = await whileBlocked('approve: bash', async () => 'n');
      expect(answer).toBe('n');
      expect(cap.titles[1]).toContain('working');
    });
  });

  it('is a silent no-op when there is no way to reach a compositor', () => {
    delete process.env.VEEWM_SOCKET;
    delete process.env.WAYLAND_DISPLAY;
    _resetForTests();
    // Outside veepOS (or over plain SSH) there is nothing to report to; the title
    // still updates and nothing errors.
    expect(() => report('done')).not.toThrow();
    expect(cap.titles).toHaveLength(1);
  });
});
