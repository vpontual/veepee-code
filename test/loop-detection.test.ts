import { describe, it, expect } from 'vitest';
import type { ToolCall } from 'ollama';
import {
  signatureOf,
  detectStuckSignature,
  LOOP_WINDOW,
  LOOP_MAX_REPEATS, detectRepeatedFailure, callSignatureOf, REPEATED_FAILURE_LIMIT,
  detectContentRepetition, CONTENT_REPETITION_LIMIT,
} from '../src/loop-detection.js';

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { function: { name, arguments: args } } as ToolCall;
}

function step(toolCalls: ToolCall[], results: string[]) {
  return { signature: signatureOf(toolCalls, results) };
}

describe('signatureOf', () => {
  it('is empty when there are no tool calls', () => {
    expect(signatureOf([], [])).toBe('');
  });

  it('throws when results length does not match tool calls length', () => {
    expect(() => signatureOf([call('ls')], [])).toThrow();
  });

  it('produces the same signature for identical name + args + result', () => {
    const a = signatureOf([call('read_file', { path: 'a.ts' })], ['hello']);
    const b = signatureOf([call('read_file', { path: 'a.ts' })], ['hello']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces a different signature when arguments differ', () => {
    const a = signatureOf([call('read_file', { path: 'a.ts' })], ['x']);
    const b = signatureOf([call('read_file', { path: 'b.ts' })], ['x']);
    expect(a).not.toBe(b);
  });

  it('produces a different signature when output differs (productive iteration)', () => {
    const a = signatureOf([call('read_file', { path: 'log.txt' })], ['line 1']);
    const b = signatureOf([call('read_file', { path: 'log.txt' })], ['line 1\nline 2']);
    expect(a).not.toBe(b);
  });
});

describe('detectStuckSignature', () => {
  it('returns null when fewer than LOOP_WINDOW steps have accumulated', () => {
    const calls = Array.from({ length: LOOP_WINDOW - 1 }, () => step([call('a')], ['out']));
    expect(detectStuckSignature(calls)).toBe(null);
  });

  it('flags N consecutive identical signatures (AAAAAA pattern)', () => {
    const calls = Array.from({ length: LOOP_WINDOW }, () => step([call('a')], ['out']));
    expect(detectStuckSignature(calls)).not.toBe(null);
  });

  it('flags ABABAB oscillation when one signature exceeds LOOP_MAX_REPEATS', () => {
    const a = step([call('a', { x: 1 })], ['out-a']);
    const b = step([call('b', { y: 2 })], ['out-b']);
    // 6 of A, 4 of B → A exceeds 5
    const interleaved = [a, b, a, b, a, b, a, b, a, a];
    expect(interleaved).toHaveLength(LOOP_WINDOW);
    expect(detectStuckSignature(interleaved)).toBe(a.signature);
  });

  it('does not flag productive AABBAABBAA where no signature exceeds the threshold', () => {
    const a = step([call('a')], ['out-a']);
    const b = step([call('b')], ['out-b']);
    // 5 of A, 5 of B in window of 10 → neither exceeds 5
    const window = [a, a, b, b, a, a, b, b, a, b];
    expect(window).toHaveLength(LOOP_WINDOW);
    expect(detectStuckSignature(window)).toBe(null);
  });

  it('does not flag the same call name when output differs each time (productive iteration)', () => {
    const steps = Array.from({ length: LOOP_WINDOW }, (_, i) =>
      step([call('read_file', { path: 'log.txt' })], [`output ${i}`]),
    );
    expect(detectStuckSignature(steps)).toBe(null);
  });

  it('skips empty signatures (turns with no tool calls)', () => {
    const empty = { signature: '' };
    const a = step([call('a')], ['out']);
    // 9 empty + 1 real → no signature ever exceeds threshold
    const mixed = [empty, empty, empty, empty, empty, empty, empty, empty, empty, a];
    expect(detectStuckSignature(mixed)).toBe(null);
  });

  it('only considers the last LOOP_WINDOW steps (older history is forgotten)', () => {
    const a = step([call('a')], ['out-a']);
    const b = step([call('b')], ['out-b']);
    // 6 of A in the FIRST 6 slots, 10 of B in the last 10 → b exceeds
    const long = [a, a, a, a, a, a, b, b, b, b, b, b, b, b, b, b];
    expect(detectStuckSignature(long)).toBe(b.signature);
  });
});

describe('detectRepeatedFailure — the loop the byte-identical check cannot see', () => {
  it('fires when the same call fails repeatedly with varying error text', () => {
    // The characteristic mid-size-model failure: `old_string not found`, again
    // and again, with a different line quoted each time — so no two RESULT
    // hashes match and `detectStuckSignature` never trips while the run burns
    // its whole budget.
    const steps = Array.from({ length: 3 }, (_, i) => ({
      signature: `different-each-time-${i}`,
      callSignature: 'same-call',
      allFailed: true,
    }));
    expect(detectRepeatedFailure(steps)).toBe('same-call');
  });

  it('a successful edit between failures is work, not a loop', () => {
    // Edit, run the tests, they fail, edit again, run again: the command is
    // byte-identical and failing every time, and that is what fixing a bug looks
    // like. Measured on a real replay task — an agent 34 calls into a working
    // change was stopped for running `npm test` three times having modified
    // three files in between.
    const steps = [
      { signature: 'a', callSignature: 'npm-test', allFailed: true },
      { signature: 'b', callSignature: 'edit', allFailed: false, mutated: true },
      { signature: 'c', callSignature: 'npm-test', allFailed: true },
      { signature: 'd', callSignature: 'edit', allFailed: false, mutated: true },
      { signature: 'e', callSignature: 'npm-test', allFailed: true },
    ];
    expect(detectRepeatedFailure(steps)).toBeNull();
  });

  it('still fires when nothing changed between the failures', () => {
    const steps = [
      { signature: 'a', callSignature: 'npm-test', allFailed: true },
      { signature: 'b', callSignature: 'npm-test', allFailed: true },
      { signature: 'c', callSignature: 'npm-test', allFailed: true },
    ];
    expect(detectRepeatedFailure(steps)).toBe('npm-test');
  });

  it('leaves productive repetition alone', () => {
    // The same bash command three times as a build progresses is fine —
    // requiring failure is what keeps this off legitimate iteration.
    const steps = Array.from({ length: 5 }, (_, i) => ({
      signature: `s${i}`,
      callSignature: 'same-call',
      allFailed: false,
    }));
    expect(detectRepeatedFailure(steps)).toBeNull();
  });

  it('does not fire below the limit', () => {
    const steps = Array.from({ length: REPEATED_FAILURE_LIMIT - 1 }, (_, i) => ({
      signature: `s${i}`,
      callSignature: 'same-call',
      allFailed: true,
    }));
    expect(detectRepeatedFailure(steps)).toBeNull();
  });

  it('distinguishes different calls that each failed once', () => {
    const steps = ['a', 'b', 'c'].map((c, i) => ({
      signature: `s${i}`, callSignature: c, allFailed: true,
    }));
    expect(detectRepeatedFailure(steps)).toBeNull();
  });

it('hashes only name and arguments, not the result', () => {
      const call = [{ function: { name: 'edit_file', arguments: { path: 'a.ts' } } }] as never;
      const other = [{ function: { name: 'edit_file', arguments: { path: 'b.ts' } } }] as never;
      expect(callSignatureOf(call)).toBe(callSignatureOf(call));
      expect(callSignatureOf(call)).not.toBe(callSignatureOf(other));
    });
  });

describe('detectContentRepetition', () => {
  it('detects the real failure: "Still writing game data... " repeated 1341 times', () => {
    const text = 'Still writing game data... '.repeat(1341);
    const result = detectContentRepetition(text);
    expect(result).not.toBeNull();
    expect(result!.count).toBeGreaterThanOrEqual(CONTENT_REPETITION_LIMIT);
  });

  it('does not flag normal code with repeated similar lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `export const K${i} = ${i};`);
    const text = lines.join('\n');
    expect(detectContentRepetition(text)).toBeNull();
  });

  it('does not flag a long prose answer with no repetition', () => {
    const text = Array.from({ length: 200 }, (_, i) =>
      `This is sentence number ${i} in a long paragraph that discusses various topics.`,
    ).join(' ');
    expect(detectContentRepetition(text)).toBeNull();
  });

  it('does not detect below the limit (11 repeats)', () => {
    const text = 'Still writing game data... '.repeat(11);
    expect(detectContentRepetition(text)).toBeNull();
  });

  it('detects at the limit (12 repeats)', () => {
    const text = 'Still writing game data... '.repeat(12);
    const result = detectContentRepetition(text);
    expect(result).not.toBeNull();
  });
});

describe('the real failure, verbatim', () => {
  it('catches the 1,341-repetition loop that killed a live task', () => {
    // 2026-08-24, first real task on veegame: the model emitted this phrase
    // 1,341 times in one turn, 43KB of output, wrote no files, and every
    // existing guard saw a model working normally — they all watch tool calls,
    // and nothing watched the content stream.
    const result = detectContentRepetition('Still writing game data... '.repeat(1341));
    expect(result).not.toBeNull();
    expect(result!.count).toBeGreaterThanOrEqual(CONTENT_REPETITION_LIMIT);
    expect(result!.repeated).toContain('Still writing game data');
  });

  it('is not fooled by a phrase that ends in whitespace', () => {
    // The first implementation called trimEnd() before matching, which breaks
    // the periodicity of a phrase ending in a space: every window from the tail
    // is misaligned by one character and the count lands one short. The real
    // phrase ended in a space, so the detector would have missed it at exactly
    // its own limit.
    // Enough repeats to clear the detector's 200-character floor, which exists
    // so short text cannot trip it.
    for (const phrase of ['working on it... ', 'thinking\n', 'processing\t']) {
      const repeats = Math.max(CONTENT_REPETITION_LIMIT + 2, Math.ceil(220 / phrase.length));
      const r = detectContentRepetition(phrase.repeat(repeats));
      expect(r, phrase).not.toBeNull();
    }
  });
});
