import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { safeTokenEquals } from '../src/auth.js';

describe('safeTokenEquals', () => {
  it('accepts an exact match', () => {
    expect(safeTokenEquals('s3cret-token', 's3cret-token')).toBe(true);
  });

  it('rejects a mismatch', () => {
    expect(safeTokenEquals('s3cret-token', 's3cret-tokeN')).toBe(false);
    expect(safeTokenEquals('wrong', 's3cret-token')).toBe(false);
  });

  it('rejects on a length mismatch instead of throwing', () => {
    // timingSafeEqual throws on unequal buffer lengths; hashing first must
    // absorb that so a short token is a plain `false`, not a 500.
    expect(() => safeTokenEquals('a', 'a-much-longer-token')).not.toThrow();
    expect(safeTokenEquals('a', 'a-much-longer-token')).toBe(false);
    expect(safeTokenEquals('a-much-longer-token', 'a')).toBe(false);
  });

  it('never authenticates an empty or missing token', () => {
    expect(safeTokenEquals('', '')).toBe(false);
    expect(safeTokenEquals('', 'expected')).toBe(false);
    expect(safeTokenEquals('presented', '')).toBe(false);
    expect(safeTokenEquals(null, 'expected')).toBe(false);
    expect(safeTokenEquals(undefined, 'expected')).toBe(false);
    expect(safeTokenEquals('presented', null)).toBe(false);
  });

  it('handles non-ascii without throwing', () => {
    expect(safeTokenEquals('tökén-✓', 'tökén-✓')).toBe(true);
    expect(safeTokenEquals('tökén-✓', 'token-x')).toBe(false);
  });
});

describe('token comparison call sites', () => {
  it('api.ts compares the bearer token in constant time', () => {
    const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf-8');
    expect(source).toContain('safeTokenEquals(token, apiToken)');
    expect(source).not.toContain('token !== apiToken');
  });

  it('rc.ts compares both header and query tokens in constant time', () => {
    const source = readFileSync(new URL('../src/rc.ts', import.meta.url), 'utf-8');
    expect(source).toContain('safeTokenEquals(authHeader.slice(7), apiToken)');
    expect(source).toContain("safeTokenEquals(url.searchParams.get('token'), apiToken)");
    expect(source).not.toContain("=== apiToken");
  });
});

describe('api server port hunting', () => {
  it('bounds EADDRINUSE retries and surfaces other bind errors', () => {
    const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf-8');
    expect(source).toContain('MAX_PORT_ATTEMPTS');
    expect(source).toContain('config.port < 65535');
    // A non-EADDRINUSE bind failure must not be swallowed silently.
    expect(source).toContain('API server is not listening');
  });
});
