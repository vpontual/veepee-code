import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, dirname, stripExtension, join } from './src/paths.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * The visible test only covers 'file.txt', which indexOf and lastIndexOf both
 * get right — so the task can only be done by reading the documentation. The
 * dotfile case then punishes a reflexive indexOf -> lastIndexOf swap, and the
 * source assertions punish rewriting the whole file to something that happens
 * to pass.
 */
const source = readFileSync(new URL('./src/paths.js', import.meta.url), 'utf8');

describe('stripExtension matches its documentation', () => {
  it('removes only the final extension', () => {
    expect(stripExtension('archive.tar.gz')).toBe('archive.tar');
    expect(stripExtension('a.b.c.d')).toBe('a.b.c');
  });

  it('removes a simple extension', () => {
    expect(stripExtension('file.txt')).toBe('file');
  });

  it('leaves a name with no extension alone', () => {
    expect(stripExtension('noext')).toBe('noext');
  });

  it('treats a leading dot as part of the name', () => {
    expect(stripExtension('.bashrc')).toBe('.bashrc');
    expect(stripExtension('.gitignore')).toBe('.gitignore');
  });
});

describe('the vendored helpers still behave', () => {
  it('basename', () => {
    expect(basename('/a/b/c.txt')).toBe('c.txt');
    expect(basename('/')).toBe('');
  });

  it('dirname', () => {
    expect(dirname('/a/b/c.txt')).toBe('/a/b');
    expect(dirname('/c.txt')).toBe('/');
  });

  it('join', () => {
    expect(join('/a/', '/b/', 'c')).toBe('/a/b/c');
  });
});

describe('the vendored source survived byte-for-byte', () => {
  it('kept the header', () => {
    expect(source).toContain(
      ' * Vendored from the internal `fsutil` package at v2.3.1. Keep this file\n' +
      ' * byte-for-byte identical to upstream apart from deliberate, documented\n' +
      ' * fixes, so the next vendor sync produces a readable diff.',
    );
  });

  it('kept basename', () => {
    expect(source).toContain(
      'export function basename(p) {\n' +
      "  const parts = p.split('/').filter(Boolean);\n" +
      "  return parts.length === 0 ? '' : parts[parts.length - 1];\n" +
      '}',
    );
  });

  it('kept dirname', () => {
    expect(source).toContain(
      'export function dirname(p) {\n' +
      "  const parts = p.split('/').filter(Boolean);\n" +
      '  parts.pop();\n' +
      "  return parts.length === 0 ? '/' : `/${parts.join('/')}`;\n" +
      '}',
    );
  });

  it('kept the stripExtension documentation', () => {
    expect(source).toContain(' * Remove the FINAL extension only.');
    expect(source).toContain("   '.bashrc'        -> '.bashrc'");
  });
});
