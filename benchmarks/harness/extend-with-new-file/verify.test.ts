import { describe, it, expect } from 'vitest';
import { validate } from './src/validate.js';
import { REGISTRY, minLength, required, email } from './src/validators/index.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * Three registration points have to line up: the new file, the barrel
 * re-export and REGISTRY. The empty-value case is the interesting one — it is
 * never stated in the task, only in a comment inside email.js, so an agent
 * that wrote minLength from imagination reports "must be at least 3
 * characters" for an empty string and fails here.
 */
describe('minLength is wired up', () => {
  it('is exported from the barrel', () => {
    expect(typeof minLength).toBe('function');
  });

  it('is in the registry', () => {
    expect(REGISTRY).toHaveProperty('minLength');
  });

  it('follows the factory shape', () => {
    const v = minLength(3);
    expect(v.name).toBe('minLength');
    expect(typeof v.check).toBe('function');
  });
});

describe('minLength behaves', () => {
  it('rejects a short value', () => {
    expect(validate({ name: 'ab' }, { name: [['minLength', 3]] }))
      .toEqual(['name must be at least 3 characters']);
  });

  it('accepts a long enough value', () => {
    expect(validate({ name: 'abc' }, { name: [['minLength', 3]] })).toEqual([]);
    expect(validate({ name: 'abcdef' }, { name: [['minLength', 3]] })).toEqual([]);
  });

  it('uses the argument in the message', () => {
    expect(validate({ name: 'a' }, { name: [['minLength', 8]] }))
      .toEqual(['name must be at least 8 characters']);
  });

  it('says nothing about an absent value, like the other optional validators', () => {
    expect(validate({ name: '' }, { name: [['minLength', 3]] })).toEqual([]);
    expect(validate({}, { name: [['minLength', 3]] })).toEqual([]);
  });

  it('leaves the absent-value complaint to required', () => {
    expect(validate({ name: '' }, { name: [['required'], ['minLength', 3]] }))
      .toEqual(['name is required']);
  });
});

describe('the existing validators still work', () => {
  it('required', () => {
    expect(required().check('', 'a')).toBe('a is required');
    expect(required().check('x', 'a')).toBeNull();
  });

  it('email', () => {
    expect(email().check('nope', 'a')).toBe('a must be a valid email address');
    expect(email().check('a@b.co', 'a')).toBeNull();
    expect(email().check('', 'a')).toBeNull();
  });

  it('validate still rejects unknown names', () => {
    expect(() => validate({}, { a: [['nope']] })).toThrow(/unknown validator/);
  });
});
