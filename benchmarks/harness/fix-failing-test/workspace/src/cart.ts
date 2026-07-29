import { toCents, fromCents, applyDiscount } from './money.js';

export interface Item {
  name: string;
  price: number;
  qty: number;
}

export function subtotal(items: Item[]): number {
  let cents = 0;
  for (const item of items) {
    cents += toCents(item.price) * item.qty;
  }
  return fromCents(cents);
}

export function total(items: Item[], discountPercent = 0): number {
  const cents = toCents(subtotal(items));
  return fromCents(applyDiscount(cents, discountPercent));
}
