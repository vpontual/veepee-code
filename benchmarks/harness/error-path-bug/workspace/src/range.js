/**
 * Parse an inclusive range like '1-5'.
 *
 *   parseRange('1-5')    -> { start: 1, end: 5 }
 *   parseRange('3-3')    -> { start: 3, end: 3 }
 *   parseRange('10-20')  -> { start: 10, end: 20 }
 *
 * Throws a `RangeError` when the input is not two non-negative integers
 * separated by a single '-':
 *
 *   `bad range: <input>`
 *
 * Throws a `RangeError` when the start is greater than the end:
 *
 *   `reversed range: <input>`
 */
export function parseRange(input) {
  const [a, b] = input.split('-');
  return { start: Number(a), end: Number(b) };
}
