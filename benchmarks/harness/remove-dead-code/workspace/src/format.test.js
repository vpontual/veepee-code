import { describe, it, expect } from 'vitest';
import { format } from './format.js';
import { sizeReport } from './report.js';
import { statusLine } from './status.js';
import { logLine } from './log.js';

describe('format', () => {
  it('formats long by default', () => {
    expect(format(1536)).toBe('1.5 KiB');
  });

  it('formats short on request', () => {
    expect(format(1536, { style: 'short' })).toBe('2K');
  });
});

describe('callers', () => {
  it('reports sizes', () => {
    expect(sizeReport([{ name: 'a', bytes: 5120 }, { name: 'b', bytes: 1536 }]))
      .toBe('a 5K\nb 2K');
  });

  it('writes a status line', () => {
    expect(statusLine(5120)).toBe('using 5K');
  });

  it('writes a log line', () => {
    expect(logLine('a', 1536)).toBe('a: 2K (1.5 KiB)');
  });
});
