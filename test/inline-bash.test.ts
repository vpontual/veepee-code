import { describe, it, expect } from 'vitest';
import { parseBang, truncateOutput, formatShellForLlm, runInlineShell } from '../src/inline-bash.js';

describe('parseBang', () => {
  it('returns send for single-bang command', () => {
    expect(parseBang('!ls src/')).toEqual({ kind: 'send', cmd: 'ls src/' });
    expect(parseBang('!git status')).toEqual({ kind: 'send', cmd: 'git status' });
  });

  it('returns silent for double-bang command', () => {
    expect(parseBang('!!ls src/')).toEqual({ kind: 'silent', cmd: 'ls src/' });
    expect(parseBang('!!echo hi')).toEqual({ kind: 'silent', cmd: 'echo hi' });
  });

  it('treats "! cmd" with leading space after bang as prose, not bang', () => {
    expect(parseBang('! ls')).toEqual({ kind: null, cmd: '' });
    expect(parseBang('! some prose with !')).toEqual({ kind: null, cmd: '' });
  });

  it('returns null for non-bang inputs', () => {
    expect(parseBang('hello world')).toEqual({ kind: null, cmd: '' });
    expect(parseBang('/help')).toEqual({ kind: null, cmd: '' });
    expect(parseBang('@file.ts review this')).toEqual({ kind: null, cmd: '' });
  });

  it('strips surrounding whitespace before parsing', () => {
    expect(parseBang('  !ls  ')).toEqual({ kind: 'send', cmd: 'ls' });
    expect(parseBang('\t!!ls\n')).toEqual({ kind: 'silent', cmd: 'ls' });
  });

  it('preserves "!" prefer-silent ordering when prefix is "!!"', () => {
    // double-bang must be detected first; if !cmd were checked first it would
    // strip just one bang and produce cmd: "!ls"
    expect(parseBang('!!ls').kind).toBe('silent');
    expect(parseBang('!!ls').cmd).toBe('ls');
  });

  it('returns empty cmd when only bang is given', () => {
    expect(parseBang('!')).toEqual({ kind: 'send', cmd: '' });
    expect(parseBang('!!')).toEqual({ kind: 'silent', cmd: '' });
  });
});

describe('truncateOutput', () => {
  it('passes short output through unchanged', () => {
    expect(truncateOutput('hello\nworld')).toBe('hello\nworld');
  });

  it('truncates output exceeding the byte cap', () => {
    const big = 'x'.repeat(10_000);
    const result = truncateOutput(big);
    expect(result.length).toBeLessThan(big.length);
    expect(result).toContain('truncated at');
  });

  it('truncates output exceeding the line cap', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const result = truncateOutput(big);
    expect(result.split('\n').length).toBeLessThanOrEqual(201);
    expect(result).toContain('truncated at');
  });

  it('returns empty string for empty input', () => {
    expect(truncateOutput('')).toBe('');
  });

  it('strips trailing whitespace', () => {
    expect(truncateOutput('hi\n\n\n')).toBe('hi');
  });
});

describe('formatShellForLlm', () => {
  it('wraps successful output with [shell] markers', () => {
    const r = { ok: true, output: 'on main', exitCode: 0 };
    expect(formatShellForLlm('git status', r)).toBe('[shell] $ git status\non main\n[/shell]');
  });

  it('includes exit code on non-zero exit', () => {
    const r = { ok: false, output: 'permission denied', exitCode: 1 };
    expect(formatShellForLlm('cat /etc/shadow', r)).toContain('(exit 1)');
  });

  it('shows "(no output)" when output is empty', () => {
    const r = { ok: true, output: '', exitCode: 0 };
    expect(formatShellForLlm('true', r)).toContain('(no output)');
  });
});

describe('runInlineShell', () => {
  it('captures stdout from a successful command', () => {
    const r = runInlineShell('echo hello');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('hello');
    expect(r.exitCode).toBe(0);
  });

  it('captures stderr and exit code on failure', () => {
    const r = runInlineShell('false');
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it('runs in the provided cwd', () => {
    const r = runInlineShell('pwd', '/tmp');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('/tmp');
  });
});
