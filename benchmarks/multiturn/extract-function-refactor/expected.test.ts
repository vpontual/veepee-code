import { describe, it, expect } from 'vitest';
import { formatUser, fullName } from './solution.js';

describe('extract-function refactor', () => {
  const u = { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' };

  it('formatUser still works after refactor', () => {
    expect(formatUser(u)).toBe('Jane Doe <jane@example.com>');
  });
  it('fullName was extracted', () => {
    expect(fullName({ firstName: 'Alan', lastName: 'Turing' })).toBe('Alan Turing');
  });
  it('fullName is the helper used by formatUser (same spelling)', () => {
    const u2 = { firstName: 'Grace', lastName: 'Hopper', email: 'grace@navy.mil' };
    expect(formatUser(u2)).toContain(fullName(u2));
  });
});
