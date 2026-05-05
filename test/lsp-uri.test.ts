import { describe, it, expect } from 'vitest';
import { pathToFileUri, fileUriToPath } from '../src/lsp/uri.js';

describe('pathToFileUri / fileUriToPath', () => {
  it('round-trips a simple POSIX path', () => {
    const p = '/home/user/project/src/foo.ts';
    expect(fileUriToPath(pathToFileUri(p))).toBe(p);
  });

  it('encodes spaces in paths', () => {
    const p = '/tmp/with space/file.ts';
    const uri = pathToFileUri(p);
    expect(uri).toContain('%20');
    expect(fileUriToPath(uri)).toBe(p);
  });

  it('encodes non-ASCII characters', () => {
    const p = '/tmp/résumé/файл.ts';
    const uri = pathToFileUri(p);
    expect(uri.startsWith('file:///')).toBe(true);
    expect(fileUriToPath(uri)).toBe(p);
  });

  it('produces a file:// scheme', () => {
    expect(pathToFileUri('/x/y.ts').startsWith('file://')).toBe(true);
  });
});
