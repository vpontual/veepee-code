import { describe, it, expect } from 'vitest';
import { flatten } from './solution.js';

describe('flatten', () => {
  it('flattens a flat array unchanged', () => {
    expect(flatten([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it('flattens one level', () => {
    expect(flatten([1, [2, 3], 4])).toEqual([1, 2, 3, 4]);
  });
  it('flattens deeply nested arrays', () => {
    expect(flatten([1, [2, [3, [4, [5]]]]])).toEqual([1, 2, 3, 4, 5]);
  });
  it('handles empty arrays', () => {
    expect(flatten([])).toEqual([]);
    expect(flatten([[], [[]]])).toEqual([]);
  });
  it('preserves mixed types', () => {
    expect(flatten([1, 'a', [true, [null]]])).toEqual([1, 'a', true, null]);
  });
  it('does not mutate input', () => {
    const input: unknown[] = [1, [2, [3]]];
    const snapshot = JSON.stringify(input);
    flatten(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
