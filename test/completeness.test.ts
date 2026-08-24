import { describe, it, expect } from 'vitest';
import {
  enumerationSites,
  findExtensionGaps,
  buildCompletenessNudge,
  selectGaps,
} from '../src/completeness.js';

/**
 * The incomplete-extension check.
 *
 * Found by the harness eval: told to add a `rename` operation "following the
 * conventions already used", the agent added the SQL branch and the registry
 * entry in render.ts and never touched validate() in operations.ts. Tests
 * passed — nothing covered the new operation — and only the grader noticed.
 */

const RENDER_AFTER = `
import { validate, type Operation } from './operations.js';
export function render(op: Operation): string {
  validate(op);
  switch (op.type) {
    case 'add_column':
      return \`ALTER TABLE \${op.table} ADD COLUMN \${op.column}\`;
    case 'drop_column':
      return \`ALTER TABLE \${op.table} DROP COLUMN \${op.column}\`;
    case 'rename':
      return \`ALTER TABLE \${op.table} RENAME COLUMN \${op.from} TO \${op.to}\`;
  }
}
export const SUPPORTED_OPERATIONS = ['add_column', 'drop_column', 'rename'] as const;
`;

const OPERATIONS_BEHIND = `
export function validate(op: Operation): void {
  if (!op.table) throw new Error('table is required');
  switch (op.type) {
    case 'add_column':
      if (!op.column) throw new Error('column is required');
      break;
    case 'drop_column':
      if (!op.column) throw new Error('column is required');
      break;
  }
}
`;

describe('enumerationSites', () => {
  it('finds switch-case label sets', () => {
    const [site] = enumerationSites('a.ts', "switch (x) { case 'a': break; case 'b': break; }");
    expect([...site.members].sort()).toEqual(['a', 'b']);
  });

  it('finds arrays of string literals', () => {
    const sites = enumerationSites('a.ts', "export const K = ['red', 'green', 'blue'] as const;");
    expect(sites.some((s) => s.members.has('green'))).toBe(true);
  });

  it('finds string-literal unions', () => {
    const sites = enumerationSites('a.ts', "type Mode = 'act' | 'plan' | 'chat';");
    expect(sites.some((s) => s.members.has('plan'))).toBe(true);
  });

  it('ignores a set too small to be a family', () => {
    expect(enumerationSites('a.ts', "switch (x) { case 'only': break; }")).toEqual([]);
  });

  it('ignores arrays that are not all literals', () => {
    expect(enumerationSites('a.ts', 'const xs = [foo, bar, baz];')).toEqual([]);
  });

  it('finds nothing in a file with no enumerations', () => {
    expect(enumerationSites('a.ts', 'export const x = 1;\nfunction f() { return 2; }')).toEqual([]);
  });
});

describe('findExtensionGaps', () => {
  it('catches the file left behind by a partial extension', () => {
    const gaps = findExtensionGaps(new Map([
      ['src/render.ts', RENDER_AFTER],
      ['src/operations.ts', OPERATIONS_BEHIND],
    ]));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].file).toBe('src/operations.ts');
    expect(gaps[0].missing).toEqual(['rename']);
    expect(gaps[0].shared).toEqual(['add_column', 'drop_column']);
    expect(gaps[0].fullerFile).toBe('src/render.ts');
  });

  it('stays quiet once the behind file catches up', () => {
    const caughtUp = OPERATIONS_BEHIND.replace(
      "    case 'drop_column':",
      "    case 'rename':\n      if (!op.from) throw new Error('from is required');\n      break;\n    case 'drop_column':",
    );
    expect(findExtensionGaps(new Map([
      ['src/render.ts', RENDER_AFTER],
      ['src/operations.ts', caughtUp],
    ]))).toEqual([]);
  });

  it('does not flag two unrelated lists that happen to differ', () => {
    expect(findExtensionGaps(new Map([
      ['a.ts', "const colours = ['red', 'green', 'blue'];"],
      ['b.ts', "const sizes = ['small', 'large'];"],
    ]))).toEqual([]);
  });

  it('needs real overlap, not one shared word', () => {
    expect(findExtensionGaps(new Map([
      ['a.ts', "const x = ['shared', 'alpha', 'beta'];"],
      ['b.ts', "const y = ['shared', 'gamma'];"],
    ]))).toEqual([]);
  });

  it('ignores a difference too large to be one missed extension', () => {
    // Four-plus members apart is two different lists, not a forgotten case.
    expect(findExtensionGaps(new Map([
      ['a.ts', "const x = ['a', 'b', 'c', 'd', 'e', 'f'];"],
      ['b.ts', "const y = ['a', 'b'];"],
    ]))).toEqual([]);
  });

  it('does not compare a file against itself', () => {
    // One file holding both a full list and a partial switch is normal.
    expect(findExtensionGaps(new Map([
      ['a.ts', "const all = ['a', 'b', 'c'];\nswitch (x) { case 'a': break; case 'b': break; }"],
    ]))).toEqual([]);
  });

  it('reports each behind file once, with its largest gap', () => {
    const gaps = findExtensionGaps(new Map([
      ['full.ts', "const x = ['a', 'b', 'c', 'd'];"],
      ['mid.ts', "const y = ['a', 'b', 'c'];"],
      ['behind.ts', "const z = ['a', 'b'];"],
    ]));
    const behind = gaps.filter((g) => g.file === 'behind.ts');
    expect(behind).toHaveLength(1);
    expect(behind[0].missing).toEqual(['c', 'd']);
  });
});

describe('buildCompletenessNudge', () => {
  it('says nothing when nothing is behind', () => {
    expect(buildCompletenessNudge([])).toBeNull();
  });

  it('names the file, what it has, and what it lacks', () => {
    const nudge = buildCompletenessNudge([
      { file: 'src/operations.ts', shared: ['add_column', 'drop_column'], missing: ['rename'], fullerFile: 'src/render.ts' },
    ]);
    expect(nudge).toContain('src/operations.ts');
    expect(nudge).toContain('"rename"');
    expect(nudge).toContain('src/render.ts');
  });

  it('asks rather than asserts, since the heuristic is good and not sound', () => {
    const nudge = buildCompletenessNudge([
      { file: 'a.ts', shared: ['x', 'y'], missing: ['z'], fullerFile: 'b.ts' },
    ]);
    expect(nudge).toMatch(/If they are meant to differ/);
  });

  it('warns that a passing suite proves nothing here', () => {
    const nudge = buildCompletenessNudge([
      { file: 'a.ts', shared: ['x', 'y'], missing: ['z'], fullerFile: 'b.ts' },
    ]);
    expect(nudge).toMatch(/do not cover code you just added/);
  });
});

describe('selectGaps — an edited file is the strongest signal, not an exemption', () => {
  const RENDER = `switch (op.type) { case 'add_column': case 'drop_column': case 'rename': }
export const SUPPORTED = ['add_column', 'drop_column', 'rename'];`;
  const OPERATIONS = `export interface Rename { type: 'rename'; from: string; to: string }
export type Operation = AddColumn | DropColumn | Rename;
export function validate(op) {
  switch (op.type) {
    case 'add_column': break;
    case 'drop_column': break;
  }
}`;
  const files = new Map([['src/render.ts', RENDER], ['src/operations.ts', OPERATIONS]]);

  it('keeps the gap when the model edited the incomplete file', () => {
    // The measured failure: told to add `rename`, the model adds the interface
    // and the union member in operations.ts, forgets the validator case two
    // functions below, and gets render.ts right. The old rule excluded any
    // edited file — throwing away the only gap that mattered.
    const gaps = findExtensionGaps(files);
    expect(gaps.map(g => g.file)).toContain('src/operations.ts');
    const selected = selectGaps(gaps, new Set(['src/operations.ts', 'src/render.ts']), files);
    expect(selected.map(g => g.file)).toContain('src/operations.ts');
  });

  it('ranks a half-finished edited file first', () => {
    const untouched = new Map(files);
    untouched.set('src/docs.ts', `const TYPES = ['add_column', 'drop_column'];`);
    const gaps = findExtensionGaps(untouched);
    const selected = selectGaps(gaps, new Set(['src/operations.ts']), untouched);
    // operations.ts was edited AND already mentions 'rename' — the model
    // committed to the extension and stopped halfway.
    expect(selected[0].file).toBe('src/operations.ts');
  });

  it('still reports a file that was never touched', () => {
    const gaps = findExtensionGaps(files);
    const selected = selectGaps(gaps, new Set(), files);
    expect(selected.length).toBe(gaps.length);
  });
});
