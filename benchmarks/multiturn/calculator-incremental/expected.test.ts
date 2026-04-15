import { describe, it, expect } from 'vitest';
import { Calculator } from './solution.js';

describe('Calculator (multiturn)', () => {
  const c = new Calculator();

  it('add works', () => {
    expect(c.add(2, 3)).toBe(5);
  });
  it('subtract still works after turn 2', () => {
    expect(c.subtract(10, 4)).toBe(6);
  });
  it('multiply added in turn 2', () => {
    expect(c.multiply(3, 4)).toBe(12);
  });
  it('add is null-safe after turn 3', () => {
    expect(c.add(null as unknown as number, 5)).toBe(5);
    expect(c.add(5, undefined as unknown as number)).toBe(5);
    expect(c.add(null as unknown as number, null as unknown as number)).toBe(0);
  });
  it('null-safety did not break normal add', () => {
    expect(c.add(7, 8)).toBe(15);
  });
});
