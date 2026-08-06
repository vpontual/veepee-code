import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fmt from './src/format.js';
import { format } from './src/format.js';
import { sizeReport } from './src/report.js';
import { statusLine } from './src/status.js';
import { logLine } from './src/log.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * Two ways to look finished and not be: migrating the callers but leaving the
 * deprecated function in place, and migrating to `format(bytes)` — whose
 * default style is 'long' — which changes every caller's output while the
 * import graph looks correct.
 */
const files = ['src/format.js', 'src/report.js', 'src/status.js', 'src/log.js'];
const sources = Object.fromEntries(
  files.map((f) => [f, readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')]),
);

describe('the deprecated function is gone', () => {
  it('is not exported', () => {
    expect((fmt as Record<string, unknown>).formatLegacy).toBeUndefined();
  });

  it('is not mentioned in any source file', () => {
    for (const [name, text] of Object.entries(sources)) {
      expect(text.includes('formatLegacy'), `${name} still mentions formatLegacy`).toBe(false);
    }
  });
});

describe('every caller produces identical output', () => {
  it('sizeReport', () => {
    expect(sizeReport([{ name: 'a', bytes: 5120 }, { name: 'b', bytes: 1536 }]))
      .toBe('a 5K\nb 2K');
    expect(sizeReport([{ name: 'x', bytes: 0 }])).toBe('x 0K');
  });

  it('statusLine', () => {
    expect(statusLine(5120)).toBe('using 5K');
    expect(statusLine(1536)).toBe('using 2K');
  });

  it('logLine', () => {
    expect(logLine('a', 1536)).toBe('a: 2K (1.5 KiB)');
    expect(logLine('b', 5120)).toBe('b: 5K (5.0 KiB)');
  });
});

describe('format itself is untouched', () => {
  it('still defaults to long', () => {
    expect(format(1536)).toBe('1.5 KiB');
    expect(format(5120)).toBe('5.0 KiB');
  });

  it('still supports short', () => {
    expect(format(1536, { style: 'short' })).toBe('2K');
    expect(format(5120, { style: 'short' })).toBe('5K');
  });
});
