import { describe, it, expect } from 'vitest';
import { parseRange } from './range.js';

describe('parseRange', () => {
  it('parses a range', () => {
    expect(parseRange('1-5')).toEqual({ start: 1, end: 5 });
  });

  it('parses a single-value range', () => {
    expect(parseRange('3-3')).toEqual({ start: 3, end: 3 });
  });

  it('parses multi-digit bounds', () => {
    expect(parseRange('10-20')).toEqual({ start: 10, end: 20 });
  });
});
