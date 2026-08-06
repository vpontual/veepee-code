/**
 * Format a share as a percentage, rounded to at most ONE decimal place.
 *
 *   formatPercent(1, 2) -> '50%'
 *   formatPercent(1, 3) -> '33.3%'
 *
 * A whole number must not gain a trailing '.0'.
 */
export function formatPercent(part, whole) {
  return `${(part / whole) * 100}%`;
}
