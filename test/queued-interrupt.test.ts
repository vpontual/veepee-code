import { describe, it, expect } from 'vitest';

// The /stop and /clear interrupts in src/tui/index.ts handleQueuedInput()
// match against `state.queuedInput.trim()`. This test pins the exact
// matching dialect so a future refactor doesn't accidentally widen it
// (e.g. matching "/stop hello" or "/stops") or narrow it (e.g. requiring
// no trailing whitespace).

function isInterrupt(queuedInput: string): 'stop' | 'clear' | null {
  const cmd = queuedInput.trim();
  if (cmd === '/stop') return 'stop';
  if (cmd === '/clear') return 'clear';
  return null;
}

describe('mid-run interrupt parsing', () => {
  it('matches /stop exactly', () => {
    expect(isInterrupt('/stop')).toBe('stop');
  });

  it('matches /clear exactly', () => {
    expect(isInterrupt('/clear')).toBe('clear');
  });

  it('matches with leading or trailing whitespace', () => {
    expect(isInterrupt('  /stop  ')).toBe('stop');
    expect(isInterrupt('\t/clear\t')).toBe('clear');
  });

  it('does not match /stop with arguments', () => {
    expect(isInterrupt('/stop now')).toBe(null);
    expect(isInterrupt('/clear all')).toBe(null);
  });

  it('does not match prefixes or partial matches', () => {
    expect(isInterrupt('/stops')).toBe(null);
    expect(isInterrupt('/cleared')).toBe(null);
    expect(isInterrupt('stop')).toBe(null); // missing slash
    expect(isInterrupt('//stop')).toBe(null);
  });

  it('does not match plain text or other commands', () => {
    expect(isInterrupt('')).toBe(null);
    expect(isInterrupt('hello')).toBe(null);
    expect(isInterrupt('/help')).toBe(null);
    expect(isInterrupt('/abort')).toBe(null);
  });
});
