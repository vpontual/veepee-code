import { describe, it, expect } from 'vitest';
import { parseRange } from './src/range.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * The visible suite is green before the agent starts, so `npm test` gives no
 * signal at all here. Everything below comes from the JSDoc contract: the
 * error type, the two message shapes, and the inputs that have to reach them.
 */
describe('the happy path still works', () => {
  it('parses ranges', () => {
    expect(parseRange('1-5')).toEqual({ start: 1, end: 5 });
    expect(parseRange('3-3')).toEqual({ start: 3, end: 3 });
    expect(parseRange('10-20')).toEqual({ start: 10, end: 20 });
    expect(parseRange('0-0')).toEqual({ start: 0, end: 0 });
  });
});

describe('malformed input throws a RangeError', () => {
  const bad = ['', '5', '1-2-3', '1-', '-5', 'a-b', '1-x', '1.5-2', ' 1-2'];

  for (const input of bad) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => parseRange(input)).toThrow(RangeError);
      expect(() => parseRange(input)).toThrow(`bad range: ${input}`);
    });
  }
});

describe('a reversed range throws a RangeError', () => {
  for (const input of ['5-1', '10-2', '1-0']) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => parseRange(input)).toThrow(RangeError);
      expect(() => parseRange(input)).toThrow(`reversed range: ${input}`);
    });
  }
});
