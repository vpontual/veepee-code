/**
 * Transport retry policy.
 *
 * vcode had one retry: a single attempt, fixed 3s, on four connection-error
 * strings. That covers a server that is DOWN and nothing else. It does not cover
 * the case this fleet actually produces — the DGX engine wedging and the
 * watchdog taking ~63 seconds to bring it back, during which every request fails
 * — nor a 429 from a busy gateway, nor a 503 while a model is loading. A turn
 * that dies inside that window loses the whole run's work, and the model never
 * sees the failure to reason about it.
 *
 * Two rules that matter more than the numbers:
 *  - `Retry-After` is obeyed when the server sends one. Guessing a backoff when
 *    the server has told you the answer is how you turn a queue into a stampede.
 *  - A CONTEXT-OVERFLOW error is never retried. It is deterministic: the same
 *    request will fail identically five times, spending a minute to arrive at
 *    the same place. That one needs compaction, not patience.
 */

export const RETRY_MAX_ATTEMPTS = 5;
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 30_000;

/** Errors worth trying again: transport faults and server-side transients. */
const RETRYABLE = /(^|\D)(429|500|502|503|504)(\D|$)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|terminated|premature close|service unavailable|too many requests|overloaded/i;

/**
 * Deterministic failures. Retrying these burns wall-clock to reach the same
 * answer — and for the context ones, hides the real fix.
 */
const NEVER_RETRY = /context length|maximum context|context_length_exceeded|too many tokens|reduce the length|400|401|403|404|422|invalid_request|model not found|does not exist|unauthorized|forbidden/i;

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
}

/** Seconds (or an HTTP-date) from a `Retry-After` header echoed in an error. */
export function retryAfterMs(message: string): number | null {
  const m = /retry-?after(?:-ms)?["'\s:=]+([^\s,"'}]+)/i.exec(message);
  if (!m) return null;
  const raw = m[1];
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    // `retry-after-ms` is milliseconds; `retry-after` is seconds. Anything that
    // large was already milliseconds whatever the header was called.
    return /retry-?after-ms/i.test(m[0]) || asNumber > 1000 ? asNumber : asNumber * 1000;
  }
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : null;
}

/**
 * Should this failure be retried, and after how long?
 *
 * `attempt` is 1-based: 1 means the first call just failed.
 * `jitter` is injectable so the schedule can be asserted in a test — real
 * callers leave it alone and get 0.75–1.25× spread, which is what stops a fleet
 * of retries re-colliding on the same second.
 */
export function retryDecision(
  err: unknown,
  attempt: number,
  opts?: { maxAttempts?: number; jitter?: number },
): RetryDecision {
  // Kill switch — same-build A/B, see `findBlockAnchorMatch` in tools/coding.ts.
  if (process.env.VCODE_NO_RETRY === '1') {
    return { retry: false, delayMs: 0, reason: 'retry disabled by VCODE_NO_RETRY' };
  }
  const maxAttempts = opts?.maxAttempts ?? RETRY_MAX_ATTEMPTS;
  const message = err instanceof Error ? `${err.message} ${String((err as { body?: unknown }).body ?? '')}` : String(err);

  if (NEVER_RETRY.test(message)) {
    return { retry: false, delayMs: 0, reason: 'deterministic failure — retrying cannot change it' };
  }
  if (!RETRYABLE.test(message)) {
    return { retry: false, delayMs: 0, reason: 'not a transport or transient error' };
  }
  if (attempt >= maxAttempts) {
    return { retry: false, delayMs: 0, reason: `giving up after ${maxAttempts} attempts` };
  }

  const server = retryAfterMs(message);
  if (server !== null) {
    return { retry: true, delayMs: Math.min(server, RETRY_CAP_MS), reason: 'server sent Retry-After' };
  }

  const jitter = opts?.jitter ?? (0.75 + Math.random() * 0.5);
  const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
  return { retry: true, delayMs: Math.round(backoff * jitter), reason: `backoff attempt ${attempt}` };
}
