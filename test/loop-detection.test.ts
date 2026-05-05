import { describe, it, expect } from 'vitest';
import type { ToolCall } from 'ollama';
import {
  signatureOf,
  detectStuckSignature,
  LOOP_WINDOW,
  LOOP_MAX_REPEATS,
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
