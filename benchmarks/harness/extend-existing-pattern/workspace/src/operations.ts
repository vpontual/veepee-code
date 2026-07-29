export interface AddColumn {
  type: 'add_column';
  table: string;
  column: string;
  dataType: string;
}

export interface DropColumn {
  type: 'drop_column';
  table: string;
  column: string;
}

export type Operation = AddColumn | DropColumn;

/** Every operation must be validated before it is rendered to SQL. */
export function validate(op: Operation): void {
  if (!op.table) throw new Error(`${op.type}: table is required`);
  switch (op.type) {
    case 'add_column':
      if (!op.column) throw new Error('add_column: column is required');
      if (!op.dataType) throw new Error('add_column: dataType is required');
      break;
    case 'drop_column':
      if (!op.column) throw new Error('drop_column: column is required');
      break;
  }
}
