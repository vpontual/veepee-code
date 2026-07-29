import { validate, type Operation } from './operations.js';

/** Render one operation to SQL. Always validates first. */
export function render(op: Operation): string {
  validate(op);
  switch (op.type) {
    case 'add_column':
      return `ALTER TABLE ${op.table} ADD COLUMN ${op.column} ${op.dataType}`;
    case 'drop_column':
      return `ALTER TABLE ${op.table} DROP COLUMN ${op.column}`;
  }
}

/** Operation types this runner knows about — used by the CLI for help text. */
export const SUPPORTED_OPERATIONS = ['add_column', 'drop_column'] as const;
