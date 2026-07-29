import { describe, it, expect } from 'vitest';
import { render, SUPPORTED_OPERATIONS } from './render.js';

describe('render', () => {
  it('renders add_column', () => {
    expect(render({ type: 'add_column', table: 'users', column: 'age', dataType: 'int' }))
      .toBe('ALTER TABLE users ADD COLUMN age int');
  });

  it('renders drop_column', () => {
    expect(render({ type: 'drop_column', table: 'users', column: 'age' }))
      .toBe('ALTER TABLE users DROP COLUMN age');
  });

  it('validates required fields', () => {
    expect(() => render({ type: 'drop_column', table: '', column: 'a' })).toThrow(/table is required/);
  });

  it('lists supported operations', () => {
    expect(SUPPORTED_OPERATIONS).toContain('add_column');
  });
});
