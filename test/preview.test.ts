import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('PreviewManager source invariants', () => {
  it('only reuses an existing server when the root directory matches', () => {
    const source = readFileSync(new URL('../src/preview.ts', import.meta.url), 'utf-8');

    expect(source).toContain('this.serverRoot === resolvedRoot');
    expect(source).toContain('this.stopServer()');
  });

  it('resolves preview request paths against the server root before traversal checks', () => {
    const source = readFileSync(new URL('../src/preview.ts', import.meta.url), 'utf-8');

    expect(source).toContain("const filePath = resolve(resolvedRoot, `.${urlPath}`)");
    expect(source).toContain("if (!filePath.startsWith(resolvedRoot))");
  });
});
