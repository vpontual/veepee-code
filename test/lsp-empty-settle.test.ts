/**
 * typescript-language-server, under load, publishes an EMPTY syntactic result
 * before the semantic one (measured: count=0 at +3065ms, count=3 at +3232ms,
 * no version on either). Resolving on the first publish reported a type error
 * as a clean edit. An empty answer now waits briefly for a follow-up.
 */
import { describe, it, expect } from 'vitest';
import { LspClient } from '../src/lsp/client.js';

const URI = 'file:///tmp/x.ts';
const DIAG = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'Type error', severity: 1 };

/** A client with no server: publishes are fed in by hand. */
function makeClient() {
  const c = Object.create(LspClient.prototype) as Record<string, unknown>;
  Object.assign(c, {
    alive: true,
    cfg: {},
    diagnostics: new Map(),
    docVersions: new Map([[URI, 1]]),
    lastDiagVersion: new Map(),
    pendingDiagWaiters: new Map(),
  });
  const client = c as unknown as LspClient;
  const publish = (diags: unknown[]) => {
    (c.diagnostics as Map<string, unknown[]>).set(URI, diags);
    (c.lastDiagVersion as Map<string, number>).set(URI, 1);
    (c as unknown as { flushWaiters(u: string, v: number): void }).flushWaiters(URI, 1);
  };
  return { client, publish };
}

describe('waitForDiagnostics with a two-stage server', () => {
  it('an empty publish followed by the real one returns the real one', async () => {
    const { client, publish } = makeClient();
    const wait = client.waitForDiagnostics(URI, 5_000);
    publish([]);
    setTimeout(() => publish([DIAG]), 170);
    expect(await wait).toEqual([DIAG]);
  });

  it('a non-empty publish resolves at once', async () => {
    const { client, publish } = makeClient();
    const started = Date.now();
    const wait = client.waitForDiagnostics(URI, 5_000);
    publish([DIAG]);
    expect(await wait).toEqual([DIAG]);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('an empty publish with no follow-up resolves clean, and is not a timeout', async () => {
    const { client, publish } = makeClient();
    const started = Date.now();
    const wait = client.waitForDiagnostics(URI, 5_000);
    publish([]);
    expect(await wait).toEqual([]);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(350);
    expect(took).toBeLessThan(2_000);
    expect(client.diagnosticsTimedOut(URI)).toBe(false);
  });

  it('no publish at all still reports a timeout', async () => {
    const { client } = makeClient();
    expect(await client.waitForDiagnostics(URI, 150)).toEqual([]);
    expect(client.diagnosticsTimedOut(URI)).toBe(true);
  });
});
