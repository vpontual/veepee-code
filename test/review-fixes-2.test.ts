import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync as read } from 'fs';
import { writeFileAtomicSync } from '../src/atomic-write.js';
import { ContextManager } from '../src/context.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vcode-rf2-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('writeFileAtomicSync', () => {
  it('writes new content', () => {
    const p = join(tmp, 'settings.json');
    writeFileAtomicSync(p, '{"a":1}\n');
    expect(readFileSync(p, 'utf-8')).toBe('{"a":1}\n');
  });

  it('replaces existing content', () => {
    const p = join(tmp, 'settings.json');
    writeFileSync(p, 'OLD');
    writeFileAtomicSync(p, 'NEW');
    expect(readFileSync(p, 'utf-8')).toBe('NEW');
  });

  it('leaves no temp file behind on success', () => {
    const p = join(tmp, 'settings.json');
    writeFileAtomicSync(p, 'x');
    expect(readdirSync(tmp)).toEqual(['settings.json']);
  });

  it('leaves the original intact and cleans up when the write fails', () => {
    const dir = join(tmp, 'ro');
    mkdirSync(dir);
    const p = join(dir, 'settings.json');
    writeFileSync(p, 'PRECIOUS');
    chmodSync(dir, 0o500); // no write permission -> temp file creation fails
    try {
      expect(() => writeFileAtomicSync(p, 'NEW')).toThrow();
      // The point of the pattern: the old file is untouched, not truncated.
      expect(readFileSync(p, 'utf-8')).toBe('PRECIOUS');
      expect(readdirSync(dir)).toEqual(['settings.json']); // no stray temp
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('keeps the temp file beside the target so rename stays on one filesystem', () => {
    // A /tmp temp file would make rename() cross-device and fail (EXDEV).
    const src = read(new URL('../src/atomic-write.ts', import.meta.url), 'utf-8');
    expect(src).toContain('`${path}.tmp-${process.pid}`');
  });
});

describe('config and trust files are written atomically', () => {
  it('settings.json and trusted-projects.json use the atomic helper', () => {
    for (const f of ['../src/config.ts', '../src/wizard.ts', '../src/hooks.ts']) {
      const src = read(new URL(f, import.meta.url), 'utf-8');
      expect(src, f).toContain('writeFileAtomicSync');
    }
    // And no longer write those files directly.
    const cfg = read(new URL('../src/config.ts', import.meta.url), 'utf-8');
    expect(cfg).not.toMatch(/writeFileSync\(path, JSON\.stringify\(config/);
    const hooks = read(new URL('../src/hooks.ts', import.meta.url), 'utf-8');
    expect(hooks).not.toMatch(/writeFileSync\(getTrustedProjectsPath\(\)/);
  });
});

describe('tool success is structured, not sniffed from the output text', () => {
  const ctx = () => new ContextManager();

  it('does not count a successful result that merely mentions "error"', () => {
    const c = ctx();
    // Reading a log file, grepping for "error", or a build printing
    // "0 errors" used to be recorded as a failure.
    c.addToolResult('read_file', 'try { ... } catch (error) { log(error) }', '/x/a.ts', true);
    c.addToolResult('bash', 'Build succeeded with 0 errors', undefined, true);
    c.addToolResult('grep', 'src/a.ts:12: throw new Error("boom")', undefined, true);

    expect(c.getSignals().errorCount).toBe(0);
  });

  it('counts a genuine failure whose text never says "error"', () => {
    const c = ctx();
    // The old substring check missed these entirely.
    c.addToolResult('bash', 'Exit code 1\ncommand not found: foo', undefined, false);
    c.addToolResult('edit_file', 'String to replace not found in file', undefined, false);

    expect(c.getSignals().errorCount).toBe(2);
  });

  it('defaults to success when a caller omits the flag', () => {
    const c = ctx();
    c.addToolResult('resumed', 'previous session content mentioning error');
    expect(c.getSignals().errorCount).toBe(0);
  });

  it('still tracks read and written files', () => {
    const c = ctx();
    c.addToolResult('read_file', 'contents', '/x/read.ts', true);
    c.addToolResult('write_file', 'ok', '/x/written.ts', true);
    const signals = c.getSignals();
    expect(signals.uniqueFilesTouched).toBe(2);
    expect(signals.fileOpsCount).toBe(1);
  });
});

describe('child processes are spawned detached and signalled by group', () => {
  it.each([
    ['../src/mcp.ts', 'MCP servers (often launched via npx)'],
    ['../src/statusline.ts', 'user statusline scripts'],
    ['../src/benchmark-exercises.ts', 'benchmark shell + vitest workers'],
  ])('%s — %s', (file) => {
    const src = read(new URL(file, import.meta.url), 'utf-8');
    expect(src).toContain('detached: true');
    expect(src).toContain('killTree(');
    // process.kill(-pid) without detached would signal vcode's own group.
    expect(src).toContain('process.kill(-proc.pid, signal)');
  });

  it('statusline closes stdin so a script reading it fails fast', () => {
    const src = read(new URL('../src/statusline.ts', import.meta.url), 'utf-8');
    expect(src).toContain('proc.stdin?.end()');
    // EPIPE arrives as an async event; an unhandled one is fatal.
    expect(src).toContain("proc.stdin?.on('error'");
  });
});
