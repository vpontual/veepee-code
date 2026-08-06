import { describe, it, expect } from 'vitest';
import { LEVELS, SEVERITY, enabled } from './levels.js';
import { prefix } from './format.js';
import { colorize } from './color.js';

describe('levels', () => {
  it('lists the known levels', () => {
    expect(LEVELS).toContain('info');
    expect(LEVELS).toContain('error');
  });

  it('orders severity', () => {
    expect(SEVERITY.info).toBeLessThan(SEVERITY.warn);
    expect(SEVERITY.warn).toBeLessThan(SEVERITY.error);
  });

  it('filters by threshold', () => {
    expect(enabled('error', 'warn')).toBe(true);
    expect(enabled('info', 'warn')).toBe(false);
  });
});

describe('rendering', () => {
  it('prefixes', () => {
    expect(prefix('info')).toBe('[INFO ]');
    expect(prefix('error')).toBe('[ERROR]');
  });

  it('colorizes', () => {
    expect(colorize('warn', 'hi')).toBe('<c33>hi</c>');
  });
});
