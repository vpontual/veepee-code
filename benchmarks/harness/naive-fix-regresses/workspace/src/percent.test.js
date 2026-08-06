import { describe, it, expect } from 'vitest';
import { formatPercent } from './percent.js';

describe('formatPercent', () => {
  it('formats a half', () => {
    expect(formatPercent(1, 2)).toBe('50%');
  });

  it('formats zero', () => {
    expect(formatPercent(0, 5)).toBe('0%');
  });

  it('rounds a repeating decimal to one place', () => {
    expect(formatPercent(1, 3)).toBe('33.3%');
  });
});
