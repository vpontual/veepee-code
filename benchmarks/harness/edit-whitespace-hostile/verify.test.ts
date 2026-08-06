import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { route, normalize } from './src/router.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * Behaviour is the easy half. The interesting half is whether the edit landed
 * without reformatting: a fuzzy whitespace match that rewrites the switch with
 * spaces, or that reindents the deliberately four-space `normalize`, produces
 * a passing feature and a diff full of unrelated churn.
 */
const source = readFileSync(new URL('./src/router.ts', import.meta.url), 'utf8');

describe('PATCH is routed', () => {
  it('returns the update form', () => {
    expect(route({ method: 'PATCH', path: '/a' })).toBe('update /a');
    expect(route({ method: 'PATCH', path: '/users/1' })).toBe('update /users/1');
  });
});

describe('the existing routes are untouched', () => {
  it('still routes the known methods', () => {
    expect(route({ method: 'GET', path: '/a' })).toBe('read /a');
    expect(route({ method: 'POST', path: '/a' })).toBe('create /a');
    expect(route({ method: 'DELETE', path: '/a' })).toBe('remove /a');
  });

  it('still rejects unknown methods', () => {
    expect(() => route({ method: 'HEAD', path: '/a' })).toThrow(/unsupported method/);
  });

  it('still normalizes', () => {
    expect(normalize('a/b')).toBe('/a/b');
    expect(normalize('/a/b//')).toBe('/a/b');
    expect(normalize('/')).toBe('/');
  });
});

describe('the file was not reformatted', () => {
  it('kept the switch tab-indented', () => {
    expect(source).toMatch(/\n\t\tcase 'GET':\n\t\t\treturn/);
    expect(source).toMatch(/\n\t\tcase 'DELETE':\n\t\t\treturn/);
  });

  it('indented the new case with tabs too', () => {
    expect(source).toMatch(/\n\t\tcase 'PATCH':\n\t\t\treturn/);
  });

  it('left the vendored four-space function alone', () => {
    expect(source).toContain("    if (!path.startsWith('/')) {\n        return `/${path}`;\n    }");
  });
});
