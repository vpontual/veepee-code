import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SandboxManager, formatSize } from '../src/sandbox.js';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

describe('formatSize', () => {
  it('formats bytes', () => {
    expect(formatSize(0)).toBe('0B');
    expect(formatSize(100)).toBe('100B');
    expect(formatSize(1023)).toBe('1023B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(1024)).toBe('1.0KB');
    expect(formatSize(1536)).toBe('1.5KB');
    expect(formatSize(10240)).toBe('10.0KB');
  });

  it('formats megabytes', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0MB');
    expect(formatSize(1.5 * 1024 * 1024)).toBe('1.5MB');
    expect(formatSize(100 * 1024 * 1024)).toBe('100.0MB');
  });
});

describe('SandboxManager', () => {
  it('generates deterministic path from session ID', () => {
    const sm = new SandboxManager('test-session-123');
    const path = sm.getPathSync();
    expect(path).toContain('test-session-123');
    expect(path).toContain('.veepee-code');
    expect(path).toContain('sandbox');
  });

  it('different session IDs produce different paths', () => {
    const sm1 = new SandboxManager('session-a');
    const sm2 = new SandboxManager('session-b');
    expect(sm1.getPathSync()).not.toBe(sm2.getPathSync());
  });

  it('resolvePath handles sandbox: prefix', () => {
    const sm = new SandboxManager('test-resolve');
    const resolved = sm.resolvePath('sandbox:output.txt');
    expect(resolved).toContain('test-resolve');
    expect(resolved).toMatch(/output\.txt$/);
  });

  it('resolvePath handles normal paths', () => {
    const sm = new SandboxManager('test-resolve');
    const resolved = sm.resolvePath('/tmp/some-file.txt');
    expect(resolved).toBe('/tmp/some-file.txt');
  });

  it('resolvePath handles relative paths against cwd', () => {
    const sm = new SandboxManager('test-resolve');
    const resolved = sm.resolvePath('relative/file.txt');
    expect(resolved).toBe(resolve(process.cwd(), 'relative/file.txt'));
  });
});

describe('SandboxManager filesystem operations', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `veepee-sandbox-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getPath creates the directory lazily', async () => {
    // SandboxManager uses SANDBOX_ROOT which is computed at module load time from HOME,
    // so we create our own manager that will use the module-level SANDBOX_ROOT.
    // Since SANDBOX_ROOT is captured at import time, this test verifies the creation logic
    // by using the actual sandbox path.
    const sm = new SandboxManager('lazy-create-test');
    const path = await sm.getPath();
    expect(existsSync(path)).toBe(true);
  });

  it('list returns empty array when directory does not exist', async () => {
    const sm = new SandboxManager('nonexistent-session');
    const files = await sm.list();
    expect(files).toEqual([]);
  });

  it('hasFiles returns false when directory does not exist', async () => {
    const sm = new SandboxManager('nonexistent-session');
    const has = await sm.hasFiles();
    expect(has).toBe(false);
  });

  it('clean removes the sandbox directory', async () => {
    const sm = new SandboxManager('clean-test');
    const path = await sm.getPath();
    expect(existsSync(path)).toBe(true);

    await sm.clean();
    expect(existsSync(path)).toBe(false);
  });

  it('clean is safe to call when directory does not exist', async () => {
    const sm = new SandboxManager('never-created');
    // Should not throw
    await sm.clean();
  });
});
