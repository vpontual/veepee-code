import { describe, it, expect } from 'vitest';
import { stripAnsi, center, rightAlign, truncate, wordWrap } from '../src/tui/screen.js';

describe('stripAnsi', () => {
  it('strips color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('strips multiple sequences', () => {
    expect(stripAnsi('\x1b[1m\x1b[34mbold blue\x1b[0m')).toBe('bold blue');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

describe('center', () => {
  it('centers text in given width', () => {
    const result = center('hi', 10);
    expect(result).toBe('    hi');
    expect(result.length).toBe(6); // left padding + text, no right padding
  });

  it('returns text unchanged if wider than width', () => {
    expect(center('long text', 4)).toBe('long text');
  });

  it('handles exact width', () => {
    expect(center('abcd', 4)).toBe('abcd');
  });

  it('centers text with ANSI codes based on visible length', () => {
    const colored = '\x1b[31mhi\x1b[0m';
    const result = center(colored, 10);
    // Should pad based on visible length (2), not raw length
    expect(result).toContain('hi');
    expect(stripAnsi(result).trimStart()).toBe('hi');
  });
});

describe('rightAlign', () => {
  it('right-aligns text in given width', () => {
    const result = rightAlign('hi', 10);
    expect(result).toBe('        hi');
    expect(result.length).toBe(10);
  });

  it('returns text unchanged if wider than width', () => {
    expect(rightAlign('long text', 4)).toBe('long text');
  });

  it('handles exact width', () => {
    expect(rightAlign('abcd', 4)).toBe('abcd');
  });
});

describe('truncate', () => {
  it('truncates long text with ellipsis', () => {
    const result = truncate('hello world this is long', 10);
    expect(stripAnsi(result).length).toBeLessThanOrEqual(10);
    expect(result).toContain('…');
  });

  it('returns short text unchanged', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });

  it('handles exact length', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('handles width of 1', () => {
    const result = truncate('hello', 1);
    expect(stripAnsi(result).length).toBeLessThanOrEqual(1);
  });
});

describe('wordWrap', () => {
  it('wraps long lines at word boundaries', () => {
    const lines = wordWrap('the quick brown fox jumps over the lazy dog', 20);
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(20);
    }
    expect(lines.length).toBeGreaterThan(1);
  });

  it('preserves newlines as separate paragraphs', () => {
    const lines = wordWrap('line one\nline two', 50);
    expect(lines).toEqual(['line one', 'line two']);
  });

  it('returns short text as single line', () => {
    const lines = wordWrap('short', 50);
    expect(lines).toEqual(['short']);
  });

  it('handles empty string', () => {
    const lines = wordWrap('', 50);
    expect(lines).toEqual(['']);
  });

  it('handles single long word', () => {
    const lines = wordWrap('superlongwordthatcannotbreak', 10);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // The word should still appear somewhere in the output
    expect(lines.join('')).toContain('superlongword');
  });
});
