import { describe, it, expect } from 'vitest';
import { findUser, domainOf } from './users.js';

describe('findUser', () => {
  it('finds a user', () => {
    expect(findUser(1).name).toBe('ada');
    expect(findUser(2).name).toBe('grace');
  });
});

describe('domainOf', () => {
  it('returns the email domain', () => {
    expect(domainOf(2)).toBe('example.com');
    expect(domainOf(3)).toBe('example.org');
  });
});
