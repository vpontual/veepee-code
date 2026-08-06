/**
 * Just enough markdown parsing for what a coding agent actually emits.
 *
 * Deliberately not a library. react-markdown plus rehype is ~40KB gzipped on
 * top of a bundle a phone pulls over WireGuard, and the agent's output is
 * overwhelmingly three things: fenced code, inline code, and paragraphs.
 *
 * Pure functions in their own module so the root vitest suite can cover them —
 * web/ has no test runner of its own and does not need one for this.
 */

export interface Fence {
  kind: 'code';
  lang: string;
  body: string;
}

export interface Prose {
  kind: 'prose';
  body: string;
}

export type Block = Fence | Prose;

/**
 * Split on fenced code blocks.
 *
 * An unterminated fence — the normal state of a response still streaming in —
 * is treated as code running to the end. Otherwise a block being typed out
 * renders as prose and then snaps to code when the closing fence lands, which
 * reflows the whole transcript under the reader mid-sentence.
 */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let prose: string[] = [];
  let code: string[] | null = null;
  let lang = '';

  const flushProse = () => {
    if (prose.length) { blocks.push({ kind: 'prose', body: prose.join('\n') }); prose = []; }
  };

  for (const line of lines) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      if (code === null) {
        flushProse();
        code = [];
        lang = fence[1].trim();
      } else {
        blocks.push({ kind: 'code', lang, body: code.join('\n') });
        code = null;
        lang = '';
      }
      continue;
    }
    if (code !== null) code.push(line);
    else prose.push(line);
  }

  if (code !== null) blocks.push({ kind: 'code', lang, body: code.join('\n') });
  flushProse();
  return blocks;
}

/** Split prose on `inline code`, keeping the backticks out of the output. */
export function splitInlineCode(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}
