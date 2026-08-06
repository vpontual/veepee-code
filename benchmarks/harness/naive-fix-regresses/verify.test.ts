import { describe, it, expect } from 'vitest';
import { formatPercent } from './src/percent.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * The failing case is 1/3. The reflexive fix is `.toFixed(1)`, which fixes it
 * and simultaneously breaks the two tests that were already passing — '50%'
 * becomes '50.0%' and '0%' becomes '0.0%'. An agent that edits and stops, or
 * that re-runs only the test it was chasing, ships a net-zero change and fails
 * here.
 */
describe('the repeating decimals round to one place', () => {
  it('one third', () => {
    expect(formatPercent(1, 3)).toBe('33.3%');
  });

  it('two thirds', () => {
    expect(formatPercent(2, 3)).toBe('66.7%');
  });

  it('one seventh', () => {
    expect(formatPercent(1, 7)).toBe('14.3%');
  });
});

describe('whole numbers keep no trailing zero', () => {
  it('a half', () => {
    expect(formatPercent(1, 2)).toBe('50%');
  });

  it('zero', () => {
    expect(formatPercent(0, 5)).toBe('0%');
  });

  it('everything', () => {
    expect(formatPercent(1, 1)).toBe('100%');
  });

  it('three quarters', () => {
    expect(formatPercent(3, 4)).toBe('75%');
  });
});

describe('exact single decimals are kept', () => {
  it('an eighth', () => {
    expect(formatPercent(1, 8)).toBe('12.5%');
  });

  it('a twentieth', () => {
    expect(formatPercent(1, 20)).toBe('5%');
  });
});
