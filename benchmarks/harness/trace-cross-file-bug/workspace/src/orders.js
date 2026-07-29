import { withTax } from './rates.js';

// Line totals are computed in DOLLARS here.
export function lineTotal(item) {
  return item.price * item.qty;
}

export function reportTotals(order) {
  const subtotal = order.items.reduce((sum, i) => sum + lineTotal(i), 0);
  // BUG: withTax expects cents, but subtotal is in dollars.
  const total = withTax(subtotal, order.region);
  return { subtotal, total };
}
