/**
 * Tests for repair-loop helpers — pure functions, no side effects.
 */
import { describe, it, expect } from 'vitest';
import {
  detectTestCommand,
  shouldAttemptRepair,
  buildRepairPrompt,
  clipOutput,
  diffTestFiles,
} from '../src/repair-loop.js';

describe('detectTestCommand', () => {
  it('returns null for echo "Error: no test specified" && exit 1', () => {
    const pkg = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect(detectTestCommand(pkg)).toBeNull();
  });

  it('returns null for unparseable JSON', () => {
    expect(detectTestCommand('not json at all')).toBeNull();
  });

  it('returns null for a missing scripts block', () => {
    const pkg = JSON.stringify({ name: 'test', version: '1.0.0' });
    expect(detectTestCommand(pkg)).toBeNull();
  });

  it('returns the script for a real one like node --test "test/*.test.js"', () => {
    const pkg = JSON.stringify({ scripts: { test: 'node --test "test/*.test.js"' } });
    expect(detectTestCommand(pkg)).toBe('node --test "test/*.test.js"');
  });
});

describe('shouldAttemptRepair', () => {
  it('is FALSE when exitCode is null (infrastructure failure)', () => {
    expect(shouldAttemptRepair({
      codeChanged: true, testCommand: 'npm test', exitCode: null, attempt: 0, maxAttempts: 3,
    })).toBe(false);
  });

  it('is FALSE when codeChanged is false', () => {
    expect(shouldAttemptRepair({
      codeChanged: false, testCommand: 'npm test', exitCode: 1, attempt: 0, maxAttempts: 3,
    })).toBe(false);
  });

  it('is FALSE at attempt === maxAttempts, TRUE at maxAttempts - 1', () => {
    // attempt 3 out of 3 → no more chances allowed
    expect(shouldAttemptRepair({
      codeChanged: true, testCommand: 'npm test', exitCode: 1, attempt: 3, maxAttempts: 3,
    })).toBe(false);

    // attempt 2 out of 3 → one more chance (maxAttempts - 1)
    expect(shouldAttemptRepair({
      codeChanged: true, testCommand: 'npm test', exitCode: 1, attempt: 2, maxAttempts: 3,
    })).toBe(true);
  });

  it('is FALSE when exitCode is 0', () => {
    expect(shouldAttemptRepair({
      codeChanged: true, testCommand: 'npm test', exitCode: 0, attempt: 0, maxAttempts: 3,
    })).toBe(false);
  });
});

describe('clipOutput', () => {
  it('leaves short text untouched', () => {
    const input = 'short output';
    expect(clipOutput(input)).toBe('short output');
  });

  it('keeps first and last characters of long text and inserts a marker naming how much was dropped', () => {
    const longText = 'a'.repeat(20_000);
    const clipped = clipOutput(longText);
    expect(clipped[0]).toBe('a');
    expect(clipped[clipped.length - 1]).toBe('a');
    expect(clipped).toContain('[... output truncated,');
    expect(clipped).toContain('characters dropped ...]');
    // Verify the drop count is correct: 20000 - 12000 = 8000
    expect(clipped).toContain('8000');
  });
});

describe('buildRepairPrompt', () => {
  it('contains the test command, the failure output, and an explicit instruction not to weaken or delete assertions', () => {
    const cmd = 'npm test';
    const output = 'AssertionError: expected 2 to equal 3';
    const prompt = buildRepairPrompt(cmd, output);
    expect(prompt).toContain(cmd);
    expect(prompt).toContain(output);
    expect(prompt).toContain('Do NOT weaken, edit, or delete any assertions');
  });
});
describe('diffTestFiles', () => {
  const f = (size: number, mtimeMs: number) => ({ size, mtimeMs });

  it('reports a DELETED test file, and not as merely modified', () => {
    // The case the original inline guard could not see. It walked only the
    // surviving files and required a `before` entry, so a deleted test was never
    // examined — while deleting the failing test is the most effective way there
    // is to turn a suite green. The report said "no test files modified".
    const before = new Map([['test/a.test.js', f(100, 1)], ['test/b.test.js', f(200, 1)]]);
    const after = new Map([['test/a.test.js', f(100, 1)]]);
    const d = diffTestFiles(before, after);
    expect(d.deleted).toEqual(['test/b.test.js']);
    expect(d.modified).toEqual([]);
    expect(d.added).toEqual([]);
  });

  it('reports an ADDED test file', () => {
    // Not necessarily wrong — a real fix may arrive with a regression test — but
    // it may not happen silently.
    const before = new Map([['test/a.test.js', f(100, 1)]]);
    const after = new Map([['test/a.test.js', f(100, 1)], ['test/new.test.js', f(50, 2)]]);
    expect(diffTestFiles(before, after).added).toEqual(['test/new.test.js']);
  });

  it('reports a file whose size changed, and one whose mtime alone changed', () => {
    const before = new Map([['a', f(100, 1)], ['b', f(100, 1)]]);
    const after = new Map([['a', f(101, 1)], ['b', f(100, 999)]]);
    expect(diffTestFiles(before, after).modified).toEqual(['a', 'b']);
  });

  it('reports an untouched file in none of the three categories', () => {
    const m = new Map([['a', f(100, 1)]]);
    const d = diffTestFiles(m, new Map(m));
    expect([d.modified, d.deleted, d.added]).toEqual([[], [], []]);
  });

  it('handles empty maps and returns sorted paths', () => {
    const empty = diffTestFiles(new Map(), new Map());
    expect([empty.modified, empty.deleted, empty.added]).toEqual([[], [], []]);
    const before = new Map([['z', f(1, 1)], ['a', f(1, 1)]]);
    const after = new Map<string, { size: number; mtimeMs: number }>();
    expect(diffTestFiles(before, after).deleted).toEqual(['a', 'z']);
  });
});
