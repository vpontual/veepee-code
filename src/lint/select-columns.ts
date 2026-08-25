/**
 * Parse the column list from a SQL SELECT statement.
 *
 * Returns a Set of exposed column names (resolving AS aliases, stripping table
 * qualifiers), 'star' when the query selects everything (nothing can be concluded),
 * or null when the text is not a SELECT at all.
 *
 * Subqueries inside the column list are NOT followed — their columns never leak
 * into the outer set.
 */
export function parseSelectedColumns(sql: string): Set<string> | 'star' | null {
  if (sql == null) return null;
  const trimmed = sql.trim();
  // Must start with SELECT (case-insensitive), ignoring leading whitespace/comments.
  const selectMatch = trimmed.match(/^(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\s*SELECT\b/i);
  if (!selectMatch) return null;

  // Strip everything before SELECT and the keyword itself.
  let rest = trimmed.slice(selectMatch[0].length);

  // A SELECT may be qualified before the column list. Leaving the qualifier
  // attached made "SELECT DISTINCT app_id" expose a column literally named
  // "DISTINCT app_id", so the real column was absent from the set and every read
  // of it was reported missing — a false positive on correct code, which is the
  // one output this lint must never produce.
  rest = rest.replace(/^\s*(DISTINCT|ALL)\b/i, '');

  // Remove trailing comments / semicolons.
  rest = rest.replace(/(?:\/\*[\s\S]*?\*\/|--[^\n]*)$/gi, '').trimEnd();

  // Split the column list by commas at depth 0, stopping at SQL clause keywords.
  const columns: string[] = [];
  let i = 0;
  let depth = 0;
  let current = '';

  while (i < rest.length) {
    const ch = rest[i];

    // Skip string literals entirely (don't count parens inside strings).
    if (ch === "'" || ch === '"') {
      const quote = ch;
      current += ch;
      i++;
      while (i < rest.length && rest[i] !== quote) {
        if (rest[i] === '\\') {
          current += rest[i];
          i++;
        }
        current += rest[i];
        i++;
      }
      if (i < rest.length) {
        current += rest[i]; // closing quote
        i++;
      }
      continue;
    }

    // Skip nested block comments.
    if (ch === '/' && rest[i + 1] === '*') {
      current += '/*';
      i += 2;
      while (i < rest.length && !(rest[i] === '*' && rest[i + 1] === '/')) {
        current += rest[i];
        i++;
      }
      if (i < rest.length) {
        current += '*/';
        i += 2;
      }
      continue;
    }

    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      columns.push(current.trim());
      current = '';
    } else if (depth === 0 && /\s/.test(ch)) {
      // On whitespace at depth 0, peek ahead to see if a SQL clause keyword follows.
      let j = i + 1;
      while (j < rest.length && /\s/.test(rest[j])) j++;
      const nextWordMatch = rest.slice(j).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (nextWordMatch) {
        const word = nextWordMatch[1].toUpperCase();
        if (/^(FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|FETCH|FOR)\b/.test(word)) {
          // End of column list — push any leftover and break.
          if (current.trim()) {
            columns.push(current.trim());
          }
          break;
        }
      }
      current += ch;
    } else {
      current += ch;
    }
    i++;
  }

  // Push the last column expression (if we didn't break on a keyword).
    // Only push if we haven't already done so via the keyword handler.
    if (i >= rest.length && current.trim()) {
      columns.push(current.trim());
    }

  // Check if the only column is a star pattern.
  if (columns.length === 1) {
    const col = columns[0].trim();
    if (/^\*\s*$/i.test(col) || /^\w+\.\*\s*$/i.test(col)) {
      return 'star';
    }
  }

  const result = new Set<string>();
  for (const col of columns) {
    const parsed = extractColumnName(col);
    if (parsed) {
      result.add(parsed);
    }
  }
  return result;
}

/**
 * Extract the exposed column name from a single column expression.
 * Handles: alias (AS), qualified names, expressions, functions.
 */
function extractColumnName(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;

  // Check for explicit alias first.
  const aliasMatch = trimmed.match(/^(.+?)\s+[Aa][Ss]\s+(\S+)$/);
  if (aliasMatch) {
    return stripQuotes(aliasMatch[2]);
  }

  // No alias — the exposed name is the column itself.
    // For qualified names like g.app_id, take the last segment.
    // For expressions like COUNT(*), we don't expose a usable name (no alias given).
    // Use word-boundary checks for SQL keywords so they don't match substrings (e.g. "category" contains "or").
    if (/\(|\+|-|\*[^.]|\/|(?<![a-z])CONCAT|(?<![a-z])COALESCE|(?<![a-z])CASE|(?<![a-z])WHEN|(?<![a-z])THEN|(?<![a-z])AND|(?<![a-z])OR|(?<![a-z])LIKE|(?<![a-z])IN\s*\(/i.test(trimmed)) {
      return null;
    }

  // Simple or qualified identifier: take the rightmost segment.
  const segments = trimmed.split('.');
  return stripQuotes(segments[segments.length - 1]);
}

function stripQuotes(name: string): string {
  return name.replace(/^["`\[]|["`\]]$/g, '');
}

/**
 * Given a set of selected columns and a set of property reads,
 * return which reads are missing from the selection, sorted.
 * Empty array for 'star' selections.
 */
export function findMissingReads(
  selected: Set<string> | 'star',
  reads: Set<string>,
): string[] {
  if (selected === 'star') return [];
  const missing: string[] = [];
  for (const r of reads) {
    if (!selected.has(r)) {
      missing.push(r);
    }
  }
  return missing.sort();
}