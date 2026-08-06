import { calcFee } from './fees.js';

/** What the customer is actually charged, in whole cents. */
export function chargeTotal(subtotalCents) {
  return subtotalCents + calcFee(subtotalCents);
}
