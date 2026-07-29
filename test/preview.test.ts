import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, sep } from 'path';

describe('PreviewManager source invariants', () => {
  it('only reuses an existing server when the root directory matches', () => {
    const source = readFileSync(new URL('../src/preview.ts', import.meta.url), 'utf-8');

    expect(source).toContain('this.serverRoot === resolvedRoot');
    expect(source).toContain('this.stopServer()');
  });

  it('resolves preview request paths against the server root', () => {
    const source = readFileSync(new URL('../src/preview.ts', import.meta.url), 'utf-8');
    expect(source).toContain("const filePath = resolve(resolvedRoot, `.${urlPath}`)");
  });

  it('rejects a sibling directory that merely shares the root prefix', () => {
    // This mirrors the guard in preview.ts. A bare startsWith(root) accepted
    // /home/u/proj-secrets when the root was /home/u/proj, serving files from
    // outside the previewed directory over the HTTP server.
    const resolvedRoot = resolve('/home/u/proj');
    const allowed = (urlPath: string): boolean => {
      const filePath = resolve(resolvedRoot, `.${urlPath}`);
      return filePath === resolvedRoot || filePath.startsWith(resolvedRoot + sep);
    };

    expect(allowed('/index.html')).toBe(true);
    expect(allowed('/nested/deep/page.html')).toBe(true);
    expect(allowed('/')).toBe(true);

    // The escape the old guard permitted.
    expect(allowed('/../proj-secrets/keys.txt')).toBe(false);
    expect(allowed('/../../etc/passwd')).toBe(false);
  });

  it('keeps the hardened guard in the source', () => {
    const source = readFileSync(new URL('../src/preview.ts', import.meta.url), 'utf-8');
    expect(source).toContain('filePath.startsWith(resolvedRoot + sep)');
    // The permissive form must not come back.
    expect(source).not.toContain('if (!filePath.startsWith(resolvedRoot))');
  });

  it('runs preview scripts detached so the timeout can kill the whole tree', () => {
    const source = readFileSync(new URL('../src/preview.ts', import.meta.url), 'utf-8');
    // SCRIPT_RUNNERS['.ts'] is `npx tsx` — the real worker is a grandchild.
    expect(source).toContain('detached: true');
    expect(source).toContain('process.kill(-proc.pid, signal)');
    // 'close' waits for stdio EOF, which a backgrounded grandchild holds open.
    expect(source).toContain("proc.on('exit'");
    expect(source).toContain('MAX_OUTPUT');
  });
});
