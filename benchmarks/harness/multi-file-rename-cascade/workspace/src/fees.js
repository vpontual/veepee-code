/** Processing fee for an order subtotal. Both in whole cents. */
export function calcFee(subtotalCents) {
  return Math.round(subtotalCents * 0.029) + 30;
}
