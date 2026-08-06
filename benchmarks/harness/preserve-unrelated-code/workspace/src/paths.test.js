import { describe, it, expect } from 'vitest';
import { basename, dirname, stripExtension, join } from './paths.js';

describe('basename', () => {
  it('returns the last segment', () => {
    expect(basename('/a/b/c.txt')).toBe('c.txt');
    expect(basename('c.txt')).toBe('c.txt');
  });
});

describe('dirname', () => {
  it('returns the parent', () => {
    expect(dirname('/a/b/c.txt')).toBe('/a/b');
    expect(dirname('/c.txt')).toBe('/');
  });
});

describe('stripExtension', () => {
  it('drops a simple extension', () => {
    expect(stripExtension('file.txt')).toBe('file');
  });
});

describe('join', () => {
  it('joins with one separator', () => {
    expect(join('/a/', '/b/', 'c')).toBe('/a/b/c');
  });
});
