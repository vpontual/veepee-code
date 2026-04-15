import { describe, it, expect } from 'vitest';
import { rot13 } from './solution.js';

describe('rot13', () => {
  it('empty string', () => {
    expect(rot13('')).toBe('');
  });
  it('basic encoding', () => {
    expect(rot13('Hello, World!')).toBe('Uryyb, Jbeyq!');
  });
  it('preserves case', () => {
    expect(rot13('abc XYZ')).toBe('nop KLM');
  });
  it('leaves non-letters unchanged', () => {
    expect(rot13('123 !@# ñ')).toBe('123 !@# ñ');
  });
  it('is its own inverse', () => {
    const samples = ['Hello, World!', 'The quick brown fox', 'ZYXWVUTSRQPONMLKJIHGFEDCBA'];
    for (const s of samples) {
      expect(rot13(rot13(s))).toBe(s);
    }
  });
});
