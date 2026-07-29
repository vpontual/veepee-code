import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { LspClient } from '../src/lsp/client.js';
import { LspManager } from '../src/lsp/manager.js';

const CFG = {
  command: 'does-not-matter',
  args: ['--stdio'],
  filetypes: ['ts'],
  rootPatterns: ['tsconfig.json'],
};

afterEach(() => { vi.restoreAllMocks(); });

/** LspClient's constructor is private; reach the prototype for pure methods. */
function clientProbe(label: string): { label: string; languageIdFor: (uri: string) => string } {
  const c = Object.create(LspClient.prototype);
  Object.defineProperty(c, 'label', { value: label, writable: true });
  return c;
}

describe('languageIdFor', () => {
  it('distinguishes the React variants', () => {
    const c = clientProbe('typescript');
    // Both branches of the old guessLanguageId returned the label, so a .tsx
    // file was announced as "typescript" — servers parse those differently.
    expect(c.languageIdFor('file:///a/b.tsx')).toBe('typescriptreact');
    expect(c.languageIdFor('file:///a/b.ts')).toBe('typescript');
    expect(c.languageIdFor('file:///a/b.jsx')).toBe('javascriptreact');
    expect(c.languageIdFor('file:///a/b.js')).toBe('javascript');
  });

  it('maps common extensions', () => {
    const c = clientProbe('python');
    expect(c.languageIdFor('file:///a/b.py')).toBe('python');
    expect(c.languageIdFor('file:///a/b.go')).toBe('go');
    expect(c.languageIdFor('file:///a/b.rs')).toBe('rust');
    expect(c.languageIdFor('file:///a/b.cpp')).toBe('cpp');
  });

  it('falls back to the server label for unknown extensions', () => {
    const c = clientProbe('typescript');
    expect(c.languageIdFor('file:///a/b.weirdext')).toBe('typescript');
    expect(c.languageIdFor('file:///a/noextension')).toBe('typescript');
  });
});

describe('waitForDiagnostics short-circuit', () => {
  /** Stand up only the fields waitForDiagnostics reads. */
  function diagProbe(opts: { version: number; lastPublished: number; diags: unknown[] }) {
    const c = Object.create(LspClient.prototype) as Record<string, unknown> & {
      waitForDiagnostics: (uri: string, t?: number) => Promise<unknown[]>;
    };
    c.alive = true;
    c.cfg = CFG;
    c.docVersions = new Map([['file:///x.ts', opts.version]]);
    c.lastDiagVersion = new Map([['file:///x.ts', opts.lastPublished]]);
    c.diagnostics = new Map([['file:///x.ts', opts.diags]]);
    c.pendingDiagWaiters = new Map();
    return c;
  }

  it('returns immediately when diagnostics for this version already arrived', async () => {
    const c = diagProbe({ version: 3, lastPublished: 3, diags: [{ message: 'boom' }] });
    const started = Date.now();
    // A 5s timeout that must NOT be waited out.
    const diags = await c.waitForDiagnostics('file:///x.ts', 5000);
    expect(Date.now() - started).toBeLessThan(250);
    expect(diags).toEqual([{ message: 'boom' }]);
  });

  it('returns immediately when the server is ahead of us', async () => {
    const c = diagProbe({ version: 2, lastPublished: 4, diags: [] });
    const started = Date.now();
    await c.waitForDiagnostics('file:///x.ts', 5000);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('still waits when the published version is stale', async () => {
    const c = diagProbe({ version: 5, lastPublished: 4, diags: [{ message: 'old' }] });
    const started = Date.now();
    // Nothing will publish, so this must fall through to the timeout path and
    // resolve with what it has.
    const diags = await c.waitForDiagnostics('file:///x.ts', 300);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(diags).toEqual([{ message: 'old' }]);
  });
});

describe('LspManager auto-restart budget', () => {
  it('stops respawning a server that keeps dying, and says why', async () => {
    let started = 0;
    const dead = { isAlive: () => false, deadMessage: () => 'server exited (code=1)', shutdown: async () => {} };
    vi.spyOn(LspClient, 'start').mockImplementation(async () => {
      started++;
      return dead as unknown as LspClient;
    });

    const mgr = new LspManager({ typescript: CFG }, '/tmp');

    // Each call finds a dead client and tries again — bounded at 3.
    for (let i = 0; i < 10; i++) await mgr.getClientByLabel('typescript');

    expect(started).toBe(1 + 3); // initial boot + MAX_AUTO_RESTARTS
    const reason = mgr.failureReason('typescript');
    expect(reason).toMatch(/not restarting again/);
    expect(reason).toMatch(/lsp restart typescript/);
  });

  it('a manual restart clears the budget', async () => {
    let started = 0;
    const dead = { isAlive: () => false, deadMessage: () => 'x', shutdown: async () => {} };
    vi.spyOn(LspClient, 'start').mockImplementation(async () => {
      started++;
      return dead as unknown as LspClient;
    });

    const mgr = new LspManager({ typescript: CFG }, '/tmp');
    for (let i = 0; i < 10; i++) await mgr.getClientByLabel('typescript');
    const afterExhaustion = started;
    expect(mgr.failureReason('typescript')).toBeTruthy();

    await mgr.restart('typescript');
    expect(started).toBeGreaterThan(afterExhaustion); // it tried again
  });
});

describe('LspManager.shutdown', () => {
  it('keeps the configured servers so the manager stays usable', async () => {
    const mgr = new LspManager({ typescript: CFG, python: { ...CFG, filetypes: ['py'] } }, '/tmp');
    expect(mgr.labels().sort()).toEqual(['python', 'typescript']);

    await mgr.shutdown();

    // Clearing the map left labels() empty and restart() returning false.
    expect(mgr.labels().sort()).toEqual(['python', 'typescript']);
    expect(mgr.runningLabels()).toEqual([]);
  });
});

describe('process-tree handling', () => {
  it('spawns language servers detached and signals the group', () => {
    const src = readFileSync(new URL('../src/lsp/client.ts', import.meta.url), 'utf-8');
    // Without detached, process.kill(-pid) would target vcode's own group.
    expect(src).toContain('detached: true');
    expect(src).toContain('process.kill(-proc.pid, signal)');
  });

  it('does not rely on beforeExit, which never fires here', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');
    // Three hooks were registered on an event that never fires: the LSP
    // shutdown, the MCP child-process cleanup, and an interval clear.
    expect(src).not.toContain("process.on('beforeExit'");
    expect(src).toContain('shutdownLspServers');
    // MCP child processes are shut down on the same explicit path.
    expect(src).toContain('activeMcpClients = mcpClients');
    // Every real exit path has to call it explicitly.
    expect((src.match(/await shutdownLspServers\(\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src).toContain('void shutdownLspServers().finally(() => process.exit(0))');
  });
});
