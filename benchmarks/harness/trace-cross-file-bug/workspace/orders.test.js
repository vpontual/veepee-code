import { describe, it, expect } from 'vitest';
import { reportTotals } from './src/orders.js';

describe('reportTotals', () => {
  it('sums the line items in dollars', () => {
    const order = { region: 'us_ca', items: [{ price: 10, qty: 2 }, { price: 5.5, qty: 1 }] };
    expect(reportTotals(order).subtotal).toBe(25.5);
  });

  it('applies the regional tax rate', () => {
    const order = { region: 'us_ca', items: [{ price: 100, qty: 1 }] };
    expect(reportTotals(order).total).toBeCloseTo(107.25, 2);
  });

  it('handles an unknown region as tax-free', () => {
    const order = { region: 'mars', items: [{ price: 40, qty: 2 }] };
    expect(reportTotals(order).total).toBeCloseTo(80, 2);
  });
});
