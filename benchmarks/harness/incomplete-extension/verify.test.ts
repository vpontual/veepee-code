import { describe, it, expect } from 'vitest';
import { LEVELS, SEVERITY, enabled, type Level } from './src/levels.js';
import { prefix } from './src/format.js';
import { colorize } from './src/color.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * The level set is enumerated in five places: the `Level` union, `LEVELS`,
 * `SEVERITY`, the `prefix` switch and the `CODES` record in color.ts. An agent
 * that adds `debug` to the two obvious ones and stops produces something that
 * looks finished, passes the visible test, and fails here — which is precisely
 * the behaviour the incomplete-extension nudge claims to prevent.
 */
const DEBUG = 'debug' as Level;

describe('debug is registered everywhere', () => {
  it('appears in LEVELS', () => {
    expect(LEVELS as readonly string[]).toContain('debug');
  });

  it('keeps LEVELS ordered least-severe-first', () => {
    const severities = LEVELS.map((l: Level) => SEVERITY[l]);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
  });

  it('is less severe than info', () => {
    expect(SEVERITY[DEBUG]).toBeLessThan(SEVERITY.info);
  });

  it('has a prefix tag', () => {
    expect(prefix(DEBUG)).toBe('[DEBUG]');
  });

  it('keeps every prefix the same width', () => {
    const widths = new Set(LEVELS.map((l: Level) => prefix(l).length));
    expect(widths.size).toBe(1);
  });

  it('has a colour', () => {
    expect(colorize(DEBUG, 'x')).toBe('<c90>x</c>');
  });

  it('filters correctly against a threshold', () => {
    expect(enabled(DEBUG, 'info')).toBe(false);
    expect(enabled('info', DEBUG)).toBe(true);
  });
});

describe('the existing levels still work', () => {
  it('keeps severities', () => {
    expect(SEVERITY.info).toBe(10);
    expect(SEVERITY.warn).toBe(20);
    expect(SEVERITY.error).toBe(30);
  });

  it('keeps prefixes', () => {
    expect(prefix('info')).toBe('[INFO ]');
    expect(prefix('warn')).toBe('[WARN ]');
    expect(prefix('error')).toBe('[ERROR]');
  });

  it('keeps colours', () => {
    expect(colorize('info', 'x')).toBe('<c36>x</c>');
    expect(colorize('error', 'x')).toBe('<c31>x</c>');
  });

  it('still filters', () => {
    expect(enabled('error', 'warn')).toBe(true);
    expect(enabled('info', 'warn')).toBe(false);
  });
});
