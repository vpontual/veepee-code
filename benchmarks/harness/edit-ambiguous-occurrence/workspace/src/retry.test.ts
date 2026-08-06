import { describe, it, expect } from 'vitest';
import { fetchUser, fetchOrder, fetchInvoice, fetchReceipt } from './retry.js';

describe('happy paths', () => {
  it('fetches each resource', () => {
    expect(fetchUser({ n: 1, max: 3 })).toBe('user:1');
    expect(fetchOrder({ n: 1, max: 3 })).toBe('order:1');
    expect(fetchInvoice({ n: 1, max: 3 })).toBe('invoice:1');
    expect(fetchReceipt({ n: 1, max: 3 })).toBe('receipt:1');
  });
});

describe('attempt limits', () => {
  it('gives up on users', () => {
    expect(() => fetchUser({ n: 4, max: 3 })).toThrow(/too many attempts/);
  });

  it('gives up on orders', () => {
    expect(() => fetchOrder({ n: 4, max: 3 })).toThrow(/too many attempts/);
  });
});
