import { parseSelectedColumns } from './select-columns.js';

/**
 * Scan source code for db.prepare() calls with SQL literals, then find
 * property reads on their results within the same function scope.
 *
 * Heuristic-based — prefers silence over noise. Only reports when the
 * association between query and read is confident.
 */
export interface QueryFinding {
  line: number;
  query: string;
  missing: string[];
}

/**
 * Find db.prepare(SQL) calls where SQL is a literal or simple concatenation
 * of literals, and correlate with property reads on the result.
 */
export function scanSource(code: string): QueryFinding[] {
  const findings: QueryFinding[] = [];
  const lines = code.split('\n');

  // Phase 1: find db.prepare(...) calls and extract the SQL + line number.
  //
  // ⚠ The SQL is USUALLY NOT ON ONE LINE. Real queries are written as a
  // multi-line concatenation of string literals, or as a template literal
  // spanning many lines:
  //
  //     db.prepare(
  //       "SELECT g.provider_id, g.app_id, " +
  //       "FROM games g "
  //     ).all()
  //
  // An earlier version matched only `db.prepare("...")` on a single line. It
  // passed its unit tests and found ZERO defects in a real 20-file codebase,
  // including one deliberately reintroduced — because no real query is written
  // that way. Collect from the opening paren to its matching close, then join
  // every string literal inside.
  const prepareCalls: Array<{ line: number; sql: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const openIdx = lines[i].search(/(?:db|database)\.prepare\s*\(/i);
    if (openIdx === -1) continue;

    // Walk forward to the matching close paren, tracking depth.
    let depth = 0;
    let buf = '';
    let started = false;
    let j = i;
    for (; j < lines.length && j < i + 60; j++) {
      const seg = j === i ? lines[j].slice(openIdx) : lines[j];
      for (const ch of seg) {
        if (ch === '(') { depth++; started = true; continue; }
        if (ch === ')') { depth--; if (depth === 0) break; continue; }
      }
      buf += seg + '\n';
      if (started && depth === 0) break;
    }

    // Join every quoted literal in the collected text — this flattens both a
    // concatenation and a template literal into one SQL string.
    const literals = buf.match(/`[^`]*`|'[^']*'|"[^"]*"/g) ?? [];
    const sql = literals
      .map((l) => l.slice(1, -1))
      .join(' ')
      .replace(/\$\{[^}]*\}/g, ' ');
    if (/\bSELECT\b/i.test(sql)) prepareCalls.push({ line: i + 1, sql });
    i = Math.max(i, j - 1);
  }

  if (prepareCalls.length === 0) return [];

  // Phase 2: for each prepare call, find the associated function scope and
  // collect property reads from .get()/.all() results and row.* accesses.
  for (const call of prepareCalls) {
    const selectedCols = parseSelectedColumns(call.sql);
    if (selectedCols === null || selectedCols === 'star') continue;

    // Find the function that contains this prepare call.
    const funcScope = findFunctionScope(lines, call.line);
    if (!funcScope) continue;

    // Collect property reads from the function scope.
    const reads = new Set<string>();

    // Pattern A: destructured reads from .get() / .all() results.
    //   const { foo, bar } = db.prepare(...).get();
    //   const result = db.prepare(...).all(); result.foo
    // Pattern B: row.* property accesses.
    //   row.app_id, r.providerId, data.name
    for (let i = funcScope.start; i <= funcScope.end && i < lines.length; i++) {
      const line = lines[i];

      // Destructured assignment from .get() / .all(): const { ... } = ...
      const destructureMatch = line.match(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*/);
      if (destructureMatch) {
        const names = destructureMatch[1].split(',').map((n) => n.trim());
        for (const name of names) {
          // Strip potential alias: "foo as bar" → "bar"
          const parts = name.split(/\s+as\s+/);
          reads.add(parts[parts.length - 1]);
        }
      }

      // Property access on a result variable: result.foo, r.bar, row.baz
      const propAccesses = line.match(/(?:^|[^.])\b(\w+)\.(\w+)\b/g);
      if (propAccesses) {
        for (const access of propAccesses) {
          const propName = access.split('.').pop()!;
          // Filter out common non-property-reads: method calls, known JS APIs.
          if (isLikelyPropertyRead(propName, line)) {
            reads.add(propName);
          }
        }
      }
    }

    // Phase 3: find missing columns.
    const missing: string[] = [];
    for (const r of reads) {
      if (!selectedCols.has(r)) {
        missing.push(r);
      }
    }

    if (missing.length > 0) {
      findings.push({ line: call.line, query: call.sql, missing: missing.sort() });
    }
  }

  return findings;
}

/**
 * Find the function scope containing a given line number.
 * Returns start/end line numbers (1-based) of the function body.
 */
function findFunctionScope(lines: string[], targetLine: number): { start: number; end: number } | null {
  // Walk backward from targetLine to find the function start.
  let braceDepth = 0;
  let funcStart = -1;

  for (let i = targetLine - 1; i >= 0; i--) {
    const line = lines[i];

    // Count braces (simple heuristic — doesn't handle nested functions perfectly but good enough).
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    if (braceDepth === 0) {
      // Found the opening brace — now go back one more to find the function keyword.
      funcStart = findFunctionStart(lines, i);
      break;
    }
  }

  if (funcStart === -1) return null;

  // Find the closing brace of the function.
  let depth = 0;
  let funcEnd = -1;
  for (let i = funcStart; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          funcEnd = i;
          break;
        }
      }
    }
    if (funcEnd !== -1) break;
  }

  if (funcEnd === -1) return { start: funcStart, end: lines.length - 1 };
  return { start: funcStart, end: funcEnd };
}

/**
 * Walk backward from a line to find the function declaration.
 */
function findFunctionStart(lines: string[], fromLine: number): number {
  for (let i = fromLine; i >= Math.max(0, fromLine - 10); i--) {
    const line = lines[i];
    if (/\b(function\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?\(?\s*\)?\s*=>|\bclass\s+\w+)/i.test(line)) {
      return i + 1; // 1-based
    }
  }
  return -1;
}

/**
 * Heuristic: is this property access likely a real data read rather than
 * a method call or JS builtin?
 */
function isLikelyPropertyRead(propName: string, line: string): boolean {
  // Skip common method calls (followed by '(').
  if (line.includes(`${propName}(`)) return false;

  // Skip common JS builtins / methods.
  const skipWords = new Set([
    'toString', 'valueOf', 'hasOwnProperty', 'toLocaleString',
    'push', 'pop', 'shift', 'unshift', 'splice', 'slice',
    'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every',
    'join', 'split', 'replace', 'match', 'search', 'includes',
    'length', 'constructor', 'prototype', 'caller', 'args',
    'then', 'catch', 'finally', 'next', 'done',
    'close', 'destroy', 'emit', 'on', 'once', 'off',
    'write', 'read', 'open', 'close', 'query', 'execute',
    'prepare', 'run', 'get', 'all',
  ]);
  if (skipWords.has(propName)) return false;

  // propName was extracted from an `x.y` match, so it IS a property access by
  // construction. The previous condition asked whether propName itself contained
  // a dot — it never does — or whether the LINE ended in `.something`, which real
  // code almost never does. Both were false essentially always, so this returned
  // false for every candidate and the whole lint reported "nothing found" while
  // catching 0 of 2 known defects. A check whose guard rejects everything is
  // indistinguishable from a clean codebase, which is the exact failure this lint
  // exists to detect.
  return true;
}