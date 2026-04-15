import { describe, it, expect } from 'vitest';
import { capitalize } from './solution.js';
import { titleCase } from './lib.js';

describe('cross-file', () => {
  it('capitalize works', () => {
    expect(capitalize('hello')).toBe('Hello');
    expect(capitalize('')).toBe('');
  });
  it('titleCase uses capitalize and joins correctly', () => {
    expect(titleCase('hello world')).toBe('Hello World');
    expect(titleCase('the quick brown fox')).toBe('The Quick Brown Fox');
  });
  it('titleCase handles single word', () => {
    expect(titleCase('typescript')).toBe('Typescript');
  });
  it('titleCase handles empty string', () => {
    expect(titleCase('')).toBe('');
  });
});
