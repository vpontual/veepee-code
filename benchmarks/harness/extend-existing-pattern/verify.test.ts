import { describe, it, expect } from 'vitest';
import { render, SUPPORTED_OPERATIONS } from './src/render.js';
import { validate } from './src/operations.js';

/**
 * Grading test, introduced only after the agent finishes.
 *
 * Written to distinguish "read the existing code and followed it" from "wrote
 * something plausible": it checks the validation conventions and the exported
 * registry, not just the happy-path SQL string. A model that adds a render
 * branch without touching validate() or SUPPORTED_OPERATIONS passes its own
 * eyeball test and fails here.
 */
describe('rename operation', () => {
  it('renders the expected SQL', () => {
    expect(render({ type: 'rename', table: 'users', from: 'age', to: 'years' } as never))
      .toBe('ALTER TABLE users RENAME COLUMN age TO years');
  });

  it('is registered as a supported operation', () => {
    expect(SUPPORTED_OPERATIONS as readonly string[]).toContain('rename');
  });

  it('follows the existing validation convention for a missing table', () => {
    expect(() => render({ type: 'rename', table: '', from: 'a', to: 'b' } as never))
      .toThrow(/table is required/);
  });

  it('validates its own required fields', () => {
    expect(() => validate({ type: 'rename', table: 't', from: '', to: 'b' } as never)).toThrow();
    expect(() => validate({ type: 'rename', table: 't', from: 'a', to: '' } as never)).toThrow();
  });

  it('accepts a fully specified rename', () => {
    expect(() => validate({ type: 'rename', table: 't', from: 'a', to: 'b' } as never)).not.toThrow();
  });
});

describe('existing operations still work', () => {
  it('renders add_column', () => {
    expect(render({ type: 'add_column', table: 'users', column: 'age', dataType: 'int' }))
      .toBe('ALTER TABLE users ADD COLUMN age int');
  });

  it('renders drop_column', () => {
    expect(render({ type: 'drop_column', table: 'users', column: 'age' }))
      .toBe('ALTER TABLE users DROP COLUMN age');
  });

  it('still validates the original operations', () => {
    expect(() => render({ type: 'add_column', table: 'u', column: 'c', dataType: '' })).toThrow(/dataType is required/);
  });
});
