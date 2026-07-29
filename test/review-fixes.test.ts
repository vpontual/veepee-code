import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseArgs } from '../src/tools/coding.js';
import { SandboxManager } from '../src/sandbox.js';
import { PermissionManager } from '../src/permissions.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vcode-review-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('parseArgs — quoted empty arguments', () => {
  it('preserves a deliberately empty argument', () => {
    // Previously `if (current)` dropped it, so git saw `commit -m` and failed
    // on a missing message.
    expect(parseArgs('commit -m ""')).toEqual(['commit', '-m', '']);
    expect(parseArgs("commit -m ''")).toEqual(['commit', '-m', '']);
  });

  it('still parses ordinary and quoted arguments', () => {
    expect(parseArgs('status')).toEqual(['status']);
    expect(parseArgs('log --oneline -10')).toEqual(['log', '--oneline', '-10']);
    expect(parseArgs('commit -m "a real message"')).toEqual(['commit', '-m', 'a real message']);
    expect(parseArgs('commit -m "it\'s fine"')).toEqual(['commit', '-m', "it's fine"]);
    expect(parseArgs('  spaced   out  ')).toEqual(['spaced', 'out']);
    expect(parseArgs('')).toEqual([]);
  });

  it('joins a quoted section onto its adjacent token', () => {
    expect(parseArgs('--flag="a b"')).toEqual(['--flag=a b']);
  });
});

describe('SandboxManager.keep — refuses to clobber', () => {
  it('throws instead of silently overwriting an existing destination', async () => {
    const sb = new SandboxManager('sess1', join(tmp, 'sandbox'));
    const dir = await sb.getPath();
    writeFileSync(join(dir, 'result.txt'), 'from sandbox');

    const dest = join(tmp, 'existing.txt');
    writeFileSync(dest, 'PRECIOUS');

    await expect(sb.keep('result.txt', dest)).rejects.toThrow(/refusing to overwrite/i);
    // The original file is untouched.
    expect(readFileSync(dest, 'utf-8')).toBe('PRECIOUS');
  });

  it('still moves the file when the destination is free', async () => {
    const sb = new SandboxManager('sess1', join(tmp, 'sandbox'));
    const dir = await sb.getPath();
    writeFileSync(join(dir, 'result.txt'), 'from sandbox');

    const dest = join(tmp, 'fresh.txt');
    const out = await sb.keep('result.txt', dest);
    expect(out).toBe(dest);
    expect(readFileSync(dest, 'utf-8')).toBe('from sandbox');
  });

  it('still refuses to read outside the sandbox root', async () => {
    const sb = new SandboxManager('sess1', join(tmp, 'sandbox'));
    await sb.getPath();
    await expect(sb.keep('../../etc/passwd', join(tmp, 'out'))).rejects.toThrow(/escapes sandbox root|not found/i);
  });
});

describe('SandboxManager.cleanupStale', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms);

  function makeSandbox(root: string, id: string, dirAgeMs: number, fileAgeMs: number) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'work.txt');
    writeFileSync(f, 'x');
    utimesSync(f, ago(fileAgeMs), ago(fileAgeMs));
    utimesSync(dir, ago(dirAgeMs), ago(dirAgeMs));
    return dir;
  }

  it('keeps a sandbox whose FILES are recent even when the directory mtime is old', async () => {
    // A directory's mtime only moves when entries are added or removed, so a
    // long session that keeps rewriting the same file looked stale and had its
    // sandbox deleted underneath it.
    const root = join(tmp, 'sandbox');
    const dir = makeSandbox(root, 'active', 3 * DAY, 60_000);

    const cleaned = await SandboxManager.cleanupStale(root);
    expect(cleaned).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('removes a sandbox where nothing has been touched', async () => {
    const root = join(tmp, 'sandbox');
    const dir = makeSandbox(root, 'stale', 3 * DAY, 3 * DAY);

    const cleaned = await SandboxManager.cleanupStale(root);
    expect(cleaned).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('never removes the live session, however old it looks', async () => {
    const root = join(tmp, 'sandbox');
    const dir = makeSandbox(root, 'live', 5 * DAY, 5 * DAY);

    const cleaned = await SandboxManager.cleanupStale(root, 'live');
    expect(cleaned).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('PermissionManager — fails closed and loads grants synchronously', () => {
  it('denies when no prompt handler is installed', async () => {
    // Entry points state their policy explicitly (-p approves, --serve denies,
    // TUI prompts) and auto_allow bypasses check() entirely, so reaching here
    // means someone forgot — answer no.
    const perms = new PermissionManager();
    const decision = await perms.check('bash', { command: 'echo hi' });
    expect(decision).toBe('deny');
  });

  it('has saved grants available on the very first check, with no await gap', async () => {
    const home = join(tmp, 'home');
    mkdirSync(join(home, '.veepee-code'), { recursive: true });
    writeFileSync(
      join(home, '.veepee-code', 'permissions.json'),
      JSON.stringify({ alwaysAllowed: ['bash'], projectAllowed: [] }),
    );

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const perms = new PermissionManager();
      // Immediately after construction — an async load would still be pending
      // here and this would prompt (and deny) instead of honouring the grant.
      const decision = await perms.check('bash', { command: 'echo hi' });
      expect(decision).toBe('allow');
      expect(perms.listPermissions().alwaysAllowed).toContain('bash');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it('a persisted grant does not override the dangerous-pattern check', async () => {
    const home = join(tmp, 'home2');
    mkdirSync(join(home, '.veepee-code'), { recursive: true });
    writeFileSync(
      join(home, '.veepee-code', 'permissions.json'),
      JSON.stringify({ alwaysAllowed: ['bash'], projectAllowed: [] }),
    );

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const perms = new PermissionManager();
      // No handler -> prompt() denies; the point is that it PROMPTS at all
      // despite the always-grant, because rm -fr is dangerous.
      const decision = await perms.check('bash', { command: 'rm -fr /tmp/x' });
      expect(decision).toBe('deny');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
