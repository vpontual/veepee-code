import { describe, it, expect } from 'vitest';
import { sum } from './solution.js';

describe('sum after bugfix', () => {
  it('empty array returns 0', () => {
    expect(sum([])).toBe(0);
  });
  it('normal arrays work', () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
    expect(sum([-5, 5])).toBe(0);
  });
  it('skips non-number entries without throwing', () => {
    const mixed = [1, 2, 'x' as unknown as number, null as unknown as number, 3, undefined as unknown as number, 4];
    expect(sum(mixed)).toBe(10);
  });
});
