/** Money is stored in whole cents to avoid floating point drift. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** Apply a percentage discount (e.g. 10 for 10% off). */
export function applyDiscount(cents: number, percent: number): number {
  return Math.round(cents - cents * percent);
}
