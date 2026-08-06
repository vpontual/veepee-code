import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { findUser, domainOf } from './src/users.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * vitest was already green before the agent touched anything — the only thing
 * wrong with this project is that it does not compile. So this grades three
 * separate claims: tsc is clean, the types were fixed rather than silenced,
 * and the error behaviour the JSDoc promises actually happens at runtime.
 */
// Everything below resolves from THIS FILE, never from process.cwd(). Running
// tsc relative to the cwd silently typechecks whatever project the runner
// happened to be launched from, which passes and measures nothing.
const here = fileURLToPath(new URL('.', import.meta.url));

function tscBin(): string {
  for (const candidate of [
    join(here, 'node_modules', '.bin', 'tsc'),
    join(here, '..', 'node_modules', '.bin', 'tsc'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  // Distinguish a broken grading environment from a failed task.
  throw new Error('tsc not found next to the grading directory — environment problem, not an agent failure');
}

const source = readFileSync(new URL('./src/users.ts', import.meta.url), 'utf8');

describe('the project typechecks', () => {
  it('tsc reports no errors', () => {
    let output = '';
    let failed = false;
    try {
      execFileSync(tscBin(), ['-p', join(here, 'tsconfig.json')], {
        cwd: here,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    }
    expect(failed, output).toBe(false);
  });
});

describe('the types were fixed, not silenced', () => {
  it('has no ts-ignore or ts-expect-error', () => {
    expect(source).not.toMatch(/@ts-(ignore|expect-error)/);
  });

  it('has no any', () => {
    expect(source).not.toMatch(/\bas\s+any\b/);
    expect(source).not.toMatch(/:\s*any\b/);
  });
});

describe('the documented behaviour holds', () => {
  it('still finds users', () => {
    expect(findUser(1).name).toBe('ada');
    expect(findUser(2).name).toBe('grace');
    expect(findUser(3).email).toBe('alan@example.org');
  });

  it('still returns email domains', () => {
    expect(domainOf(2)).toBe('example.com');
    expect(domainOf(3)).toBe('example.org');
  });

  it('throws with the id when the user does not exist', () => {
    expect(() => findUser(99)).toThrow(/99/);
  });

  it('throws with the id when the user has no email', () => {
    expect(() => domainOf(1)).toThrow(/\b1\b/);
  });
});
