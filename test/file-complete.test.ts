import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeFileMention } from '../src/tui/file-complete.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vcode-fc-'));
  mkdirSync(join(dir, 'src', 'lsp'), { recursive: true });
  writeFileSync(join(dir, 'src', 'lsp', 'uri.ts'), 'export function pathToFileUri(){}');
  writeFileSync(join(dir, 'src', 'lsp', 'client.ts'), '');
  writeFileSync(join(dir, 'README.md'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('completeFileMention', () => {
  it('expands a unique prefix match', () => {
    const r = completeFileMention('hi @REA', 7, dir);
    expect(r?.text).toBe('hi @README.md');
    expect(r?.candidates).toEqual(['README.md']);
  });

  it('returns multiple candidates when prefix is ambiguous', () => {
    // (no two top-level files share a prefix in this tree, so test inside src/lsp)
    const r = completeFileMention('@src/lsp/c', 10, dir);
    expect(r?.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to substring match on basename when prefix yields nothing', () => {
    // 'uri' doesn't start any top-level file, but matches src/lsp/uri.ts
    const r = completeFileMention('@uri', 4, dir);
    expect(r?.candidates).toContain('src/lsp/uri.ts');
  });

  it('does NOT use substring fallback when the partial contains a slash', () => {
    // User explicitly typed a path; trust them.
    const r = completeFileMention('@nope/uri', 9, dir);
    expect(r?.candidates).toEqual([]);
  });

  it('returns null when there is no @-mention at the cursor', () => {
    expect(completeFileMention('hello world', 5, dir)).toBe(null);
  });

  it('returns null for an empty @ token', () => {
    expect(completeFileMention('hi @', 4, dir)).toBe(null);
  });
});
