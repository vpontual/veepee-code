/**
 * Shared YAML-frontmatter reader for the three markdown-with-metadata formats
 * vcode loads: skills, user commands, and output styles.
 *
 * These had three byte-identical copies of this function. Beyond the
 * duplication, all three mishandled CRLF: a file saved on Windows (or fetched
 * through a tool that normalises line endings) left a trailing \r on every
 * value, so `name: deploy\r` parsed as `"deploy\r"` — which then failed to
 * match any lookup — and the quote-stripping check saw `"deploy"\r`, whose
 * last character is not a quote, so the quotes survived too.
 */

export interface Frontmatter {
  meta: Record<string, string>;
  /** Markdown body with the frontmatter block removed. */
  body: string;
}

/**
 * A block-scalar header: `>` (folded) or `|` (literal), optionally followed by
 * an indentation digit and/or a chomping indicator, in either order. Nothing
 * else may follow on that line — `foo: > bar` is a plain string in YAML, not a
 * block, and treating it as one would silently swallow the next lines.
 */
const BLOCK_HEADER = /^([>|])(?:[0-9][+-]?|[+-][0-9]?)?$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

export function parseFrontmatter(raw: string): Frontmatter {
  // Normalise line endings up front so every downstream check is CRLF-safe.
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const meta: Record<string, string> = {};
  if (!text.startsWith('---')) return { meta, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta, body: text };

  // Sliced, not trimmed: block scalars are indentation-sensitive, so the
  // interior lines have to reach the loop with their leading spaces intact.
  const lines = text.slice(3, end).split('\n');
  const body = text.slice(end + 4).replace(/^\n/, '');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    const block = BLOCK_HEADER.exec(value);
    if (block) {
      // Multi-line value. Both skills Omarchy ships write their description
      // this way (`description: >` then an indented paragraph), and the
      // line-based parser used to record the literal ">" as the description
      // while every indented line that happened to contain a colon —
      // "Triggers: crash, segfault, …" — became its own bogus key.
      const folded = block[1] === '>';
      const keyIndent = indentOf(line);
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j];
        // Blank lines belong to the block only if the block continues after
        // them; trailing blanks are dropped below.
        if (next.trim() === '') { collected.push(''); continue; }
        if (indentOf(next) <= keyIndent) break;
        collected.push(next);
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      // Strip the common indent so the value reads as written, not as nested.
      const indents = collected.filter((l) => l !== '').map(indentOf);
      const strip = indents.length > 0 ? Math.min(...indents) : 0;
      const content = collected.map((l) => (l === '' ? '' : l.slice(strip)));
      // Folded joins lines into one paragraph and keeps blank lines as breaks;
      // literal keeps every line. Chomping indicators are accepted but not
      // honoured — every consumer trims the value anyway.
      value = folded
        ? content.reduce((acc, l) => {
            if (l === '') return `${acc}\n`;          // blank line = paragraph break
            if (acc === '' || acc.endsWith('\n')) return acc + l;
            return `${acc} ${l}`;                     // fold: newline becomes a space
          }, '').replace(/\n+$/, '')
        : content.join('\n');
      meta[key] = value;
      i = j - 1;
      continue;
    }

    // Strip simple surrounding quotes
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body };
}
