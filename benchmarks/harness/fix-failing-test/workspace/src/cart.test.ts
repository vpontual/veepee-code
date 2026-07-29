import { describe, it, expect } from 'vitest';
import { subtotal, total } from './cart.js';

const items = [
  { name: 'widget', price: 9.99, qty: 3 },
  { name: 'gadget', price: 4.50, qty: 2 },
];

describe('cart', () => {
  it('sums line items without floating point drift', () => {
    expect(subtotal(items)).toBe(38.97);
  });

  it('applies no discount by default', () => {
    expect(total(items)).toBe(38.97);
  });

  it('applies a percentage discount', () => {
    // 10% off 38.97 = 35.07
    expect(total(items, 10)).toBe(35.07);
  });

  it('handles a 100% discount', () => {
    expect(total(items, 100)).toBe(0);
  });
});
