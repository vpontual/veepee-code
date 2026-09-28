/**
 * Pinky without a local clone.
 *
 * The brain is a folder of markdown, and vcode used to find it only on disk
 * ($PINKY_ROOT, ~/pinky, ~/Nextcloud/pinky). A machine without a clone — a GPU
 * box, vpmm's `vp` user, the sandboxed archman service that runs the Nightly
 * Engineer — got no operator context at all.
 *
 * The Pinky MCP server (over ssh to archman) exposes `pinky_context`, which
 * returns the eager-load files from the canonical clone. At startup, when there
 * is no local clone, vcode asks it and mirrors the files into
 * ~/.veepee-code/cache/pinky/. findPinkyRoot() falls back to that folder, so
 * the prompt budget, the PINKY.md pointer (readable with read_file) and
 * offline use all work as they do with a real clone. The mirror is refreshed
 * on every start that can reach the server and used as-is when it cannot.
 */
import { mkdirSync, writeFileSync, renameSync } from 'fs';
import { dirname, join, normalize, isAbsolute } from 'path';
import type { McpClient } from './mcp.js';

/** Where the mirror lives. */
export function pinkyCacheDir(home: string = process.env.HOME || '~'): string {
  return join(home, '.veepee-code', 'cache', 'pinky');
}

/** Split `pinky_context` output into files. Only the known relative paths. */
export function parsePinkyContext(text: string): Array<{ rel: string; content: string }> {
  const out: Array<{ rel: string; content: string }> = [];
  const re = /^=== (.+?) ===$/gm;
  const marks = [...text.matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const rel = marks[i][1].trim();
    // The server is trusted, but a path must never leave the cache folder.
    if (isAbsolute(rel) || normalize(rel).startsWith('..') || !/^[\w./-]+\.md$/.test(rel)) continue;
    const start = marks[i].index! + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : text.length;
    const content = text.slice(start, end).trim();
    if (content) out.push({ rel, content });
  }
  return out;
}

/**
 * Mirror the brain's eager-load files from a connected MCP server that offers
 * `pinky_context`. Returns the number of files written (0 = nothing to do or
 * the server could not answer — the previous mirror, if any, stays).
 */
export async function mirrorPinkyFromMcp(clients: McpClient[], cacheDir = pinkyCacheDir()): Promise<number> {
  for (const client of clients) {
    let text = '';
    try {
      const res = await Promise.race([
        client.callTool('pinky_context', {}),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
      if (res.isError) continue;
      text = (res.content ?? []).map(c => (c.type === 'text' ? c.text : '')).join('');
    } catch {
      continue; // not a Pinky server, or it did not answer
    }
    const files = parsePinkyContext(text);
    if (!files.some(f => f.rel === 'PINKY.md')) continue;
    for (const { rel, content } of files) {
      const path = join(cacheDir, rel);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, content + '\n', 'utf-8');
      renameSync(tmp, path);
    }
    return files.length;
  }
  return 0;
}
