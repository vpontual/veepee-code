/**
 * Minimal unified-diff renderer for edit/write previews.
 *
 * Used to show the user what an `edit_file` or `write_file` call is about to
 * do before it actually mutates anything. The aim is "good enough to make
 * an informed decision," not "matches `git diff` byte-for-byte" — small
 * code in service of clear UX.
 *
 * Algorithm: line-level LCS via O(n*m) DP, then walk the matrix to emit
 * context/added/removed lines. For typical edit_file changes (a few lines
 * modified in a file of hundreds), this is fast enough that we don't need a
 * Myers implementation. If real-world payloads stress the DP table size,
 * we cap context window before falling back to "first N changed lines."
 */

import chalk from 'chalk';

export interface DiffOptions {
  /** Path label shown in the diff header (e.g. file path). */
  label: string;
  /** Number of unchanged context lines to show around each change. */
  context?: number;
  /** Maximum lines emitted before truncating. */
  maxLines?: number;
}

interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  oldLine?: number;
  newLine?: number;
  text: string;
}

/** Compute the LCS table for two arrays of lines. Returns a matrix where
 *  M[i][j] is the LCS length of a[0..i) and b[0..j). */
function lcsMatrix(a: string[], b: string[]): number[][] {
  const n = a.length, m = b.length;
  // Allocate (n+1) × (m+1) — typical edits with ~hundreds of lines fit in
  // tens of KB. For pathological large files we'd cap before reaching here.
  const M: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (a[i] === b[j]) M[i + 1][j + 1] = M[i][j] + 1;
      else M[i + 1][j + 1] = Math.max(M[i][j + 1], M[i + 1][j]);
    }
  }
  return M;
}

/** Walk the LCS table backwards to produce a sequence of edit operations. */
function walk(a: string[], b: string[], M: number[][]): DiffLine[] {
  const ops: DiffLine[] = [];
  let i = a.length, j = b.length;
  let oldNum = a.length, newNum = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ kind: 'context', oldLine: oldNum, newLine: newNum, text: a[i - 1] });
      i--; j--; oldNum--; newNum--;
    } else if (j > 0 && (i === 0 || M[i][j - 1] >= M[i - 1][j])) {
      ops.unshift({ kind: 'add', newLine: newNum, text: b[j - 1] });
      j--; newNum--;
    } else if (i > 0) {
      ops.unshift({ kind: 'remove', oldLine: oldNum, text: a[i - 1] });
      i--; oldNum--;
    } else {
      break;
    }
  }
  return ops;
}

/** Trim runs of context lines down to `context` on each side of changes. */
function withContext(ops: DiffLine[], context: number): DiffLine[] {
  if (ops.length === 0) return ops;
  // Mark which context lines are within `context` of any change.
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind !== 'context') {
      for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
        keep[k] = true;
      }
    }
  }
  const out: DiffLine[] = [];
  let lastKept = -2;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) continue;
    if (lastKept !== -1 && i - lastKept > 1) {
      out.push({ kind: 'context', text: '@@ ... @@' });
    }
    out.push(ops[i]);
    lastKept = i;
  }
  return out;
}

/** Render a unified diff as a colored, multi-line string. */
export function renderDiff(oldText: string, newText: string, opts: DiffOptions): string {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 200;

  // Trailing newline normalization — strip a single trailing \n from each
  // side so we don't show a phantom "removed empty line at EOF" diff.
  const stripTrail = (s: string) => s.endsWith('\n') ? s.slice(0, -1) : s;
  const a = stripTrail(oldText).split('\n');
  const b = stripTrail(newText).split('\n');

  // No-op
  if (oldText === newText) {
    return chalk.dim(`(no changes to ${opts.label})`);
  }

  const ops = walk(a, b, lcsMatrix(a, b));
  const trimmed = withContext(ops, context);

  const lines: string[] = [];
  lines.push(chalk.bold(`--- ${opts.label}`));
  lines.push(chalk.bold(`+++ ${opts.label}`));

  let emitted = 0;
  for (const op of trimmed) {
    if (emitted >= maxLines) {
      lines.push(chalk.dim(`... (${trimmed.length - emitted} more lines truncated)`));
      break;
    }
    emitted++;
    if (op.kind === 'context' && op.text === '@@ ... @@') {
      lines.push(chalk.cyan(op.text));
    } else if (op.kind === 'context') {
      lines.push(chalk.dim(' ' + op.text));
    } else if (op.kind === 'add') {
      lines.push(chalk.green('+' + op.text));
    } else {
      lines.push(chalk.red('-' + op.text));
    }
  }

  // Stats footer
  const added = ops.filter((o) => o.kind === 'add').length;
  const removed = ops.filter((o) => o.kind === 'remove').length;
  lines.push(chalk.dim(`(${added} addition${added === 1 ? '' : 's'}, ${removed} deletion${removed === 1 ? '' : 's'})`));
  return lines.join('\n');
}

/** Convenience wrapper for the most common case — preview an edit_file
 *  call. Returns the colored diff or a placeholder if the file is binary
 *  (heuristic: presence of NUL byte). */
export function previewEdit(
  oldContent: string,
  newContent: string,
  path: string,
): string {
  if (oldContent.includes('\0') || newContent.includes('\0')) {
    return chalk.dim(`(binary file ${path} — diff not shown)`);
  }
  return renderDiff(oldContent, newContent, { label: path });
}

/** Preview a write_file call against an existing file (full-file diff) or
 *  a new file (truncated content peek with marker). */
export function previewWrite(
  existingContent: string | null,
  newContent: string,
  path: string,
): string {
  if (existingContent === null) {
    const peek = newContent.split('\n').slice(0, 20).join('\n');
    const overflow = newContent.split('\n').length > 20 ? '\n…' : '';
    return chalk.bold(`+++ ${path} (new file)\n`) +
      chalk.green(peek.split('\n').map((l) => '+' + l).join('\n') + overflow);
  }
  return previewEdit(existingContent, newContent, path);
}
