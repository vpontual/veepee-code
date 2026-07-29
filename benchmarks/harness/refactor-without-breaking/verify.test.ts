import { describe, it, expect } from 'vitest';
import { formatDuration } from './src/format.js';
import { summarize, verboseSummary, timestampRow } from './src/report.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * A refactor is graded on two things at once: that the new interface exists,
 * and that nothing downstream broke. The visible suite only exercises the
 * callers, so an agent could satisfy it by leaving formatDuration's signature
 * alone; and an agent that changes the signature without updating every caller
 * satisfies nothing. Both failure modes are checked here.
 */
describe('the new options interface', () => {
  it('takes an options object', () => {
    expect(formatDuration(3661000, { long: false })).toBe('1h 1m 1s');
    expect(formatDuration(65250, { long: true, showMs: true }))
      .toBe('1 minutes, 5 seconds, 250 milliseconds');
    expect(formatDuration(3661000, { pad: true })).toBe('01h 01m 01s');
  });

  it('works with no options at all', () => {
    expect(formatDuration(45000)).toBe('45s');
    expect(formatDuration(45000, {})).toBe('45s');
  });

  it('does not silently accept the old positional booleans', () => {
    // The old call formatDuration(ms, true, true) must no longer mean
    // "long, showMs" — otherwise the signature was never really replaced.
    // An options object is truthy, so passing `true` should not turn on `long`.
    expect(formatDuration(65250, true as never)).not.toBe('1 minutes, 5 seconds');
  });

  it('combines options independently', () => {
    expect(formatDuration(3661000, { long: true })).toBe('1 hours, 1 minutes, 1 seconds');
    expect(formatDuration(5000, { showMs: true })).toBe('5s 0ms');
    expect(formatDuration(5000, { pad: true })).toBe('05s');
  });
});

describe('every caller still produces identical output', () => {
  const runs = [{ name: 'build', ms: 3661000 }, { name: 'test', ms: 45000 }];

  it('summarize', () => {
    expect(summarize(runs)).toBe('build: 1h 1m 1s\ntest: 45s');
  });

  it('verboseSummary', () => {
    expect(verboseSummary([{ name: 'x', ms: 65250 }]))
      .toBe('x: 1 minutes, 5 seconds, 250 milliseconds');
  });

  it('timestampRow', () => {
    expect(timestampRow({ name: 'y', ms: 3661000 })).toBe('y\t01h 01m 01s');
  });

  it('handles sub-minute and multi-hour values through the callers', () => {
    expect(summarize([{ name: 'a', ms: 999 }])).toBe('a: 0s');
    expect(summarize([{ name: 'b', ms: 7322000 }])).toBe('b: 2h 2m 2s');
  });
});
