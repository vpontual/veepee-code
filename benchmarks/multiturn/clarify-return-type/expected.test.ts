import { describe, it, expect } from 'vitest';
import { parseInt10 } from './solution.js';

describe('parseInt10 as Result', () => {
  it('returns ok for valid inputs', () => {
    const r = parseInt10('42');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });
  it('returns ok for negatives', () => {
    const r = parseInt10('-17');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(-17);
  });
  it('returns error for non-numeric', () => {
    const r = parseInt10('banana');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.error).toBe('string');
  });
  it('does not throw', () => {
    expect(() => parseInt10('')).not.toThrow();
    expect(() => parseInt10('abc')).not.toThrow();
  });
});
