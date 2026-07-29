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

export function parseFrontmatter(raw: string): Frontmatter {
  // Normalise line endings up front so every downstream check is CRLF-safe.
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const meta: Record<string, string> = {};
  if (!text.startsWith('---')) return { meta, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta, body: text };

  const fm = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n/, '');

  for (const line of fm.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
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
