import { describe, it, expect } from 'vitest';
import { validate } from './validate.js';

describe('validate', () => {
  it('reports a missing required field', () => {
    expect(validate({}, { name: [['required']] })).toEqual(['name is required']);
  });

  it('accepts a valid email', () => {
    expect(validate({ email: 'a@b.co' }, { email: [['email']] })).toEqual([]);
  });

  it('rejects a malformed email', () => {
    expect(validate({ email: 'nope' }, { email: [['email']] }))
      .toEqual(['email must be a valid email address']);
  });

  it('does not double-report an absent optional value', () => {
    expect(validate({ email: '' }, { email: [['email']] })).toEqual([]);
  });

  it('rejects an unknown validator', () => {
    expect(() => validate({}, { a: [['nope']] })).toThrow(/unknown validator/);
  });
});
