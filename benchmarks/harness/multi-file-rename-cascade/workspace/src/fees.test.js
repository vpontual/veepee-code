import { describe, it, expect } from 'vitest';
import { chargeTotal } from './checkout.js';
import { dispatch } from './dispatch.js';

describe('fees', () => {
  it('charges the subtotal plus the fee', () => {
    expect(chargeTotal(10000)).toBe(10320);
  });
});

describe('dispatch', () => {
  it('routes the total event', () => {
    expect(dispatch('total', 10000)).toBe(10320);
  });

  it('rejects an unknown event', () => {
    expect(() => dispatch('nope')).toThrow(/no handler/);
  });
});
