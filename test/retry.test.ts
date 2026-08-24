import { describe, it, expect } from 'vitest';
import { retryDecision, retryAfterMs, RETRY_MAX_ATTEMPTS } from '../src/retry.js';

/**
 * The old policy was one attempt, fixed 3s, on four connection-error strings.
 * On this fleet the failure that matters is the DGX engine wedging with the
 * watchdog taking ~63s to bring it back — every request in that window failed
 * the turn outright.
 */
describe('retryDecision', () => {
  const fixed = { jitter: 1 };

  it('retries transport faults and server transients', () => {
    for (const msg of [
      'OpenAI /v1 backend HTTP 503: engine loading',
      'OpenAI /v1 backend HTTP 429: too many requests',
      'HTTP 502 Bad Gateway',
      'fetch failed',
      'socket hang up',
      'read ECONNRESET',
      'connect ECONNREFUSED 10.0.154.246:8000',
      'getaddrinfo EAI_AGAIN llm-api.casarp.us',
    ]) {
      expect(retryDecision(new Error(msg), 1, fixed).retry, msg).toBe(true);
    }
  });

  it('never retries a deterministic failure', () => {
    // Retrying these spends a minute to arrive at the same answer — and for the
    // context ones it hides the real fix, which is compaction.
    for (const msg of [
      "This model's maximum context length is 131072 tokens",
      'context_length_exceeded',
      'HTTP 401: unauthorized',
      'HTTP 404: model not found',
      'HTTP 400: invalid_request_error',
    ]) {
      expect(retryDecision(new Error(msg), 1, fixed).retry, msg).toBe(false);
    }
  });

  it('does not retry something that is not a transport error at all', () => {
    expect(retryDecision(new Error('tool schema mismatch'), 1, fixed).retry).toBe(false);
  });

  it('backs off exponentially and caps', () => {
    const d = (n: number) => retryDecision(new Error('HTTP 503'), n, fixed).delayMs;
    expect(d(1)).toBe(1_000);
    expect(d(2)).toBe(2_000);
    expect(d(3)).toBe(4_000);
    expect(d(4)).toBe(8_000);
    // Long enough in total to cover a ~63s watchdog recovery.
    expect(d(1) + d(2) + d(3) + d(4)).toBeGreaterThan(14_000);
  });

  it('gives up after the attempt cap', () => {
    expect(retryDecision(new Error('HTTP 503'), RETRY_MAX_ATTEMPTS, fixed).retry).toBe(false);
  });

  it('obeys Retry-After over any backoff it would compute', () => {
    expect(retryAfterMs('HTTP 429 {"retry-after": "7"}')).toBe(7_000);
    expect(retryAfterMs('HTTP 429 retry-after-ms: 250')).toBe(250);
    expect(retryAfterMs('no header here')).toBeNull();
    const d = retryDecision(new Error('HTTP 429 retry-after: 5'), 1, fixed);
    expect(d.delayMs).toBe(5_000);
    expect(d.reason).toContain('Retry-After');
  });

  it('waits out an engine that is coming back, rather than giving up in 15 seconds', () => {
    // The DGX watchdog takes ~63s to notice a wedged engine and 4-5 minutes to
    // cold-load it. Measured 2026-08-23: an overnight eval lost five consecutive
    // tasks to ECONNREFUSED while the watchdog was already restarting the
    // engine, and every one was recorded as a harness failure.
    const d = retryDecision(new Error('fetch failed {"code":"ECONNREFUSED","port":8000}'), 1, fixed);
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBe(30_000);
    expect(d.reason).toContain('unreachable');
    // Long enough to cover a cold load several times over.
    expect(retryDecision(new Error('ECONNREFUSED'), 15, fixed).retry).toBe(true);
    expect(retryDecision(new Error('ECONNREFUSED'), 20, fixed).retry).toBe(false);
  });

  it('treats a terminated socket as unreachable, not as a transient', () => {
    const d = retryDecision(new Error('terminated {"name":"SocketError","code":"UND_ERR_SOCKET"}'), 1, fixed);
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBe(30_000);
  });

  it('keeps HTTP transients on the short exponential schedule', () => {
    // A 429 is a busy server, not an absent one — waiting 30s per attempt there
    // would turn a two-second hiccup into a minute of dead time.
    expect(retryDecision(new Error('HTTP 429'), 1, fixed).delayMs).toBe(1_000);
  });

  it('spreads retries with jitter by default', () => {
    const delays = new Set(
      Array.from({ length: 20 }, () => retryDecision(new Error('HTTP 503'), 3).delayMs),
    );
    // A fleet of retries that all wake on the same second re-collides.
    expect(delays.size).toBeGreaterThan(1);
  });
});
