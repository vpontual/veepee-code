import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time comparison of a presented token against the expected one.
 *
 * A plain `===` on secrets short-circuits at the first differing byte, so the
 * time it takes to reject leaks a prefix oracle. We hash both sides to a fixed
 * 32 bytes first — that keeps the comparison constant-time *and* stops the
 * length of the presented token from leaking (timingSafeEqual throws outright
 * on a length mismatch, which would be its own oracle).
 *
 * Returns false when either side is empty, so a missing token never
 * accidentally authenticates.
 */
export function safeTokenEquals(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!presented || !expected) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
