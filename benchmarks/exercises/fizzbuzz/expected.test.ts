import { describe, it, expect } from 'vitest';
import { fizzbuzz } from './solution.js';

describe('fizzbuzz', () => {
  it('handles n=0', () => {
    expect(fizzbuzz(0)).toEqual([]);
  });
  it('handles n=1', () => {
    expect(fizzbuzz(1)).toEqual(['1']);
  });
  it('produces correct first 15', () => {
    expect(fizzbuzz(15)).toEqual([
      '1', '2', 'Fizz', '4', 'Buzz',
      'Fizz', '7', '8', 'Fizz', 'Buzz',
      '11', 'Fizz', '13', '14', 'FizzBuzz',
    ]);
  });
  it('FizzBuzz at 30, 45', () => {
    const out = fizzbuzz(45);
    expect(out[14]).toBe('FizzBuzz');
    expect(out[29]).toBe('FizzBuzz');
    expect(out[44]).toBe('FizzBuzz');
  });
});
