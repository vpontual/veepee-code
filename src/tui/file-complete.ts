/**
 * Tab-completion for @file mentions in the input field.
 *
 * Detects an `@<partial>` token at the cursor, globs matching paths in the
 * project, and either:
 *   - replaces the partial with the unique match (if exactly one), or
 *   - returns the list of candidates so the caller can render them as a
 *     system message (shell-style tab-complete behavior).
 *
 * Kept terminal-only — does not pop a menu component. Matches the shell
 * tab-complete model: type more to disambiguate, hit Tab again to refine.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { resolve, relative } from 'path';

const MAX_CANDIDATES = 50;
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '__pycache__',
  'venv', '.venv', 'target', 'vendor', '.cache', 'scratch',
]);

export interface CompletionResult {
  /** Cursor position after operation, if `text` is set. */
  cursor?: number;
  /** New input text, if a unique match was applied. */
  text?: string;
  /** All candidate paths (when multiple matches; caller renders these). */
  candidates: string[];
  /** The partial token that triggered completion (for display). */
  partial: string;
}

/** Locate the `@<partial>` token at the cursor (if any). Returns null
 *  when the cursor isn't inside a mention. */
function findMention(input: string, cursor: number): { start: number; end: number; partial: string } | null {
  // Walk back from cursor looking for `@`. Stop at whitespace.
  let i = cursor - 1;
  while (i >= 0 && !/\s/.test(input[i])) {
    if (input[i] === '@') {
      const partial = input.slice(i + 1, cursor);
      // Walk forward to find end of token (cursor or next whitespace).
      let end = cursor;
      while (end < input.length && !/\s/.test(input[end])) end++;
      return { start: i, end, partial: input.slice(i + 1, end) };
    }
    i--;
  }
  return null;
}

/** Glob the project for files matching `<partial>*`. Returns paths relative
 *  to cwd, sorted shortest-first (so simple matches surface above
 *  deeply-nested ones). */
function findCandidates(partial: string, cwd: string): string[] {
  const out: string[] = [];
  // If the partial contains a slash, treat as a path prefix and walk only
  // that subtree. Otherwise walk the whole project.
  const lastSlash = partial.lastIndexOf('/');
  const baseDir = lastSlash >= 0 ? resolve(cwd, partial.slice(0, lastSlash)) : cwd;
  const namePartial = lastSlash >= 0 ? partial.slice(lastSlash + 1) : partial;

  if (!existsSync(baseDir)) return [];

  const stack: string[] = [baseDir];
  while (stack.length > 0 && out.length < MAX_CANDIDATES) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (out.length >= MAX_CANDIDATES) break;
      if (name.startsWith('.') && name !== '..') continue;
      if (SKIP_DIRS.has(name)) continue;
      // For the immediate baseDir, only include matches starting with the
      // partial (case-insensitive). Recurse into all matching dirs.
      const full = resolve(dir, name);
      const isDir = (() => { try { return statSync(full).isDirectory(); } catch { return false; } })();
      const matchesPartial = !namePartial || name.toLowerCase().startsWith(namePartial.toLowerCase());
      if (dir === baseDir && !matchesPartial && !isDir) continue;
      if (isDir && (dir === baseDir ? matchesPartial : true)) {
        stack.push(full);
      }
      if (!isDir && (dir === baseDir ? matchesPartial : true)) {
        out.push(relative(cwd, full));
      }
    }
  }
  return out.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Attempt to complete an @file mention at the cursor. */
export function completeFileMention(
  input: string,
  cursor: number,
  cwd: string = process.cwd(),
): CompletionResult | null {
  const m = findMention(input, cursor);
  if (!m || m.partial.length === 0) return null;

  const candidates = findCandidates(m.partial, cwd);
  if (candidates.length === 0) {
    return { partial: m.partial, candidates: [] };
  }
  if (candidates.length === 1) {
    const replacement = '@' + candidates[0];
    const newText = input.slice(0, m.start) + replacement + input.slice(m.end);
    const newCursor = m.start + replacement.length;
    return { text: newText, cursor: newCursor, partial: m.partial, candidates };
  }
  // Multiple — try common-prefix expansion (shell-style).
  const common = longestCommonPrefix(candidates);
  if (common.length > m.partial.length) {
    const replacement = '@' + common;
    const newText = input.slice(0, m.start) + replacement + input.slice(m.end);
    const newCursor = m.start + replacement.length;
    return { text: newText, cursor: newCursor, partial: m.partial, candidates };
  }
  return { partial: m.partial, candidates };
}

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let prefix = strs[0];
  for (let i = 1; i < strs.length && prefix.length > 0; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix === '') return '';
    }
  }
  return prefix;
}
