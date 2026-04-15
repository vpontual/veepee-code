import { describe, it, expect } from 'vitest';
import { isPrime } from './solution.js';

describe('isPrime', () => {
  it('returns false for n <= 1', () => {
    expect(isPrime(0)).toBe(false);
    expect(isPrime(1)).toBe(false);
    expect(isPrime(-3)).toBe(false);
  });
  it('returns true for 2', () => {
    expect(isPrime(2)).toBe(true);
  });
  it('identifies small primes', () => {
    for (const p of [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]) {
      expect(isPrime(p)).toBe(true);
    }
  });
  it('identifies small composites', () => {
    for (const c of [4, 6, 8, 9, 10, 12, 14, 15, 16, 21, 25]) {
      expect(isPrime(c)).toBe(false);
    }
  });
  it('handles larger primes', () => {
    expect(isPrime(97)).toBe(true);
    expect(isPrime(101)).toBe(true);
    expect(isPrime(7919)).toBe(true);
  });
  it('handles non-integers as not-prime', () => {
    expect(isPrime(2.5)).toBe(false);
    expect(isPrime(3.1)).toBe(false);
  });
});
