import { describe, it, expect } from 'vitest';
import { fetchUser, fetchOrder, fetchInvoice, fetchReceipt } from './src/retry.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * The guard block is byte-identical in all four functions. An edit that
 * anchors on it without enough surrounding context lands on the wrong one —
 * and the visible test, which only asserts the fetchUser and fetchOrder
 * throws, still passes when fetchReceipt was silently changed instead.
 */
describe('fetchInvoice no longer throws', () => {
  it('returns null past the limit', () => {
    expect(fetchInvoice({ n: 4, max: 3 })).toBeNull();
  });

  it('returns null well past the limit', () => {
    expect(fetchInvoice({ n: 99, max: 1 })).toBeNull();
  });

  it('still works under the limit', () => {
    expect(fetchInvoice({ n: 1, max: 3 })).toBe('invoice:1');
    expect(fetchInvoice({ n: 3, max: 3 })).toBe('invoice:3');
  });
});

describe('every other fetcher still throws', () => {
  it('fetchUser throws', () => {
    expect(() => fetchUser({ n: 4, max: 3 })).toThrow(/too many attempts/);
  });

  it('fetchOrder throws', () => {
    expect(() => fetchOrder({ n: 4, max: 3 })).toThrow(/too many attempts/);
  });

  it('fetchReceipt throws', () => {
    expect(() => fetchReceipt({ n: 4, max: 3 })).toThrow(/too many attempts/);
  });

  it('keeps their happy paths', () => {
    expect(fetchUser({ n: 2, max: 3 })).toBe('user:2');
    expect(fetchOrder({ n: 2, max: 3 })).toBe('order:2');
    expect(fetchReceipt({ n: 2, max: 3 })).toBe('receipt:2');
  });
});
