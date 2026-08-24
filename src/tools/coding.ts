import { readFile, writeFile, stat, readdir, mkdir } from 'fs/promises';
import { resolve, relative, join, dirname } from 'path';
import { existsSync } from 'fs';
import { execSync, execFileSync, spawn } from 'child_process';

/**
 * Ceiling for the SYNCHRONOUS tools here (`grep`, `git`).
 *
 * They block the event loop, so the registry's 10-minute race cannot fire for
 * them — the timer it schedules never gets a chance to run. A slow `git push`
 * over a flaky link, or a `grep` over a huge tree, therefore froze the TUI, the
 * API server and every background task at once, with no visible symptom beyond
 * "vcode stopped".
 */
const SYNC_CMD_TIMEOUT_MS = 60_000;
import { glob as globFn } from 'glob';
import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import type { IgnoreManager } from '../ignore.js';
import type { FileTracker } from '../filetracker.js';
import type { LspManager } from '../lsp/manager.js';
import { notifyLSPs } from '../lsp/manager.js';
import { formatDiagnostics } from '../lsp/diagnostics.js';
import { pathToFileUri } from '../lsp/uri.js';

/** How long to wait for stdio EOF after a command has already exited. Covers
 *  the normal in-flight-buffer case without waiting on a background process
 *  that inherited the pipe and may never release it. */
const OUTPUT_FLUSH_GRACE_MS = 250;

/**
 * Accept a structured argument that arrived as a JSON string.
 *
 * Models serialise array and object arguments fairly often — some more than
 * others, and the same model inconsistently within one session. Zod then
 * rejects the call before `execute` ever runs, and the model gets
 * "Expected array, received string", which it usually answers by sending the
 * same thing again. Observed in the harness eval on multi_edit:
 *
 *   Invalid arguments for multi_edit: 'edits': Expected array, received string
 *   (got string "[{\"old_string\": \"im…
 *
 * The intent there is unambiguous and the content is valid JSON, so parsing it
 * costs nothing and saves a turn. A string that is NOT valid JSON is passed
 * through untouched, so zod still produces its normal error rather than a
 * confusing one about parsing.
 */
export function jsonish<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }, schema);
}

export function registerCodingTools(ignoreManager?: IgnoreManager, fileTracker?: FileTracker, lspManager?: LspManager): ToolDef[] {
  return [
    createReadFileTool(ignoreManager, fileTracker, lspManager),
    createWriteFileTool(ignoreManager, fileTracker, lspManager),
    createEditFileTool(ignoreManager, fileTracker, lspManager),
    createMultiEditTool(ignoreManager, fileTracker, lspManager),
    createGlobTool(ignoreManager),
    createGrepTool(ignoreManager),
    createBashTool(fileTracker),
    createGitTool(),
    createGithubTool(),
    createListFilesTool(),
    createUpdateMemoryTool(),
  ];
}

/**
 * Best-effort: sync the file with the matching LSP, wait briefly for diags,
 * format and append. When LSP isn't configured for the file's extension, or
 * the manager wasn't provided, returns an empty string so the original
 * tool output is byte-identical to the pre-Phase-B behavior.
 */
async function appendLspDiagnostics(
  lspManager: LspManager | undefined,
  filePath: string,
): Promise<string> {
  if (!lspManager) return '';
  try {
    const label = lspManager.matchByPath(filePath);
    // No language server for this file type is not a clean bill of health
    // either — it means nothing checked the edit. Said ONCE per extension per
    // session: the fact is static, and repeating it on every edit would be
    // noise that trains the model to skip the whole block.
    if (!label) {
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      if (ext && ext.length <= 6 && !announcedNoLsp.has(ext)) {
        announcedNoLsp.add(ext);
        return `\n\n<lsp_status>\nNo language server is configured for ${ext} files, so this edit was not type-checked. Verify it by building or running tests.\n</lsp_status>`;
      }
      return '';
    }
    const { timedOut } = await notifyLSPs(lspManager, filePath);
    const block = formatDiagnostics(lspManager.getAllDiagnostics(), filePath);
    const failure = lspManager.failureReason(label);
    // SILENCE IS NOT CLEANLINESS. If the server did not answer in time, the
    // empty block means "we do not know yet" and was being handed to the model
    // as "no problems" — so a broken edit read as a compiling one. Under load
    // (a full test run, a busy machine) this is not rare.
    if (!block && timedOut) {
      return `\n\n<lsp_status>\nDiagnostics were not available in time — this is NOT a clean bill of health. Re-check with lsp_diagnostics or by building.\n</lsp_status>`;
    }
    if (!block && failure) {
      return `\n\n<lsp_status>\nWarning: LSP diagnostics unavailable: ${failure}\n</lsp_status>`;
    }
    return block ? `\n\n${block}` : '';
  } catch (err) {
    const label = lspManager.matchByPath(filePath);
    const reason = label ? lspManager.failureReason(label) : null;
    const message = reason || (err instanceof Error ? err.message : String(err));
    return message ? `\n\n<lsp_status>\nWarning: LSP diagnostics unavailable: ${message}\n</lsp_status>` : '';
  }
}

function createReadFileTool(ignoreManager?: IgnoreManager, fileTracker?: FileTracker, lspManager?: LspManager): ToolDef {
  return {
    name: 'read_file',
    description: 'Read a file from the filesystem. Returns the full file content with line numbers. Use this to understand code before making changes.',
    schema: z.object({
      path: z.string().describe('Absolute or relative file path to read'),
      offset: z.number().optional().describe('Start reading from this line number (1-based)'),
      limit: z.number().optional().describe('Maximum number of lines to return'),
    }),
    execute: async (params) => {
      try {
        const filePath = resolve(params.path as string);
        const blocked = ignoreManager?.getBlockedReason(filePath);
        if (blocked) return fail(`Access blocked by .veepeignore (${blocked}): ${filePath}`);
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        const offset = ((params.offset as number) || 1) - 1;
        // A read with no `limit` used to mean "the entire file, whatever its
        // size" — one call could put a 2 MB minified bundle or a lockfile into
        // the window and end the session's usable context, and the model had no
        // way to know before making the call. A default ceiling turns that into
        // a paged read the model can continue deliberately with `offset`.
        const READ_DEFAULT_MAX_LINES = 2_000;
        const READ_MAX_CHARS = 120_000;
        const requested = params.limit as number | undefined;
        const limit = requested && requested > 0 ? requested : Math.min(lines.length, READ_DEFAULT_MAX_LINES);
        const slice = lines.slice(offset, offset + limit);

        let numbered = slice
          .map((line, i) => `${String(offset + i + 1).padStart(5)}  ${line}`)
          .join('\n');

        const notes: string[] = [];
        if (numbered.length > READ_MAX_CHARS) {
          // Long LINES (minified code, embedded data) blow the budget even
          // inside the line cap, so bound the characters too.
          numbered = numbered.slice(0, READ_MAX_CHARS);
          const shownLines = numbered.split('\n').length;
          notes.push(`[truncated at ${READ_MAX_CHARS} chars — ${shownLines} of ${lines.length} lines shown; continue with offset=${offset + shownLines + 1}]`);
        } else if (offset + slice.length < lines.length) {
          notes.push(`[showing lines ${offset + 1}-${offset + slice.length} of ${lines.length} — continue with offset=${offset + slice.length + 1}${requested ? '' : `, or pass an explicit limit`}]`);
        }
        if (notes.length) numbered += `\n${notes.join('\n')}`;

        fileTracker?.recordRead(filePath);

        // Phase D: fire-and-forget open in the matching LSP server so it
        // has the file cached for later diagnostics queries. Never blocks
        // read_file; never throws.
        if (lspManager) {
          const label = lspManager.matchByPath(filePath);
          if (label) {
            lspManager.getClientByLabel(label).then((c) => {
              if (!c) return;
              return c.openFile(pathToFileUri(filePath), c.label, content);
            }).catch(() => undefined);
          }
        }

        return ok(numbered);
      } catch (err) {
        return fail(`Cannot read file: ${(err as Error).message}`);
      }
    },
  };
}

function createWriteFileTool(ignoreManager?: IgnoreManager, fileTracker?: FileTracker, lspManager?: LspManager): ToolDef {
  return {
    name: 'write_file',
    description: 'Write content to a file, creating it if it does not exist or overwriting if it does. Use for creating new files.',
    schema: z.object({
      path: z.string().describe('File path to write to'),
      content: z.string().describe('The full content to write to the file'),
    }),
    execute: async (params) => {
      try {
        const filePath = resolve(params.path as string);
        const blocked = ignoreManager?.getBlockedReason(filePath);
        if (blocked) return fail(`Access blocked by .veepeignore (${blocked}): ${filePath}`);
        // Staleness check: only complain if the file already exists. Creating
        // a brand-new file is always fine.
        if (fileTracker) {
          const stale = fileTracker.checkFresh(filePath, false);
          if (stale) return fail(stale);
        }
        // Create the parent directory. Without this, writing a new file into a
        // directory that does not exist yet fails with a bare ENOENT — and a
        // model told "ENOENT" for a path it believes is correct retries the
        // identical call. Measured on a real replay task: three identical
        // write_file calls, the run stopped by the loop guard, 432 seconds
        // burned, and the whole failure logged as the model being stuck. Every
        // other agent in this class creates the directory; not doing so turns an
        // ordinary "add a new module" into an unrecoverable one.
        await mkdir(dirname(filePath), { recursive: true }).catch(() => {});
        await writeFile(filePath, params.content as string, 'utf-8');
        fileTracker?.recordRead(filePath);
        const lines = (params.content as string).split('\n').length;
        const summary = `Wrote ${lines} lines to ${relative(process.cwd(), filePath)}`;
        const diagBlock = await appendLspDiagnostics(lspManager, filePath);
        return ok(summary + diagBlock);
      } catch (err) {
        return fail(`Cannot write file: ${(err as Error).message}`);
      }
    },
  };
}

/**
 * A capped capture of a stream that keeps BOTH ends.
 *
 * Head and tail are each bounded; everything between them is counted and
 * discarded. The count is reported, because a truncation the model cannot see
 * is a truncation it will reason past.
 */
export function boundedStream(headMax = 192 * 1024, tailMax = 192 * 1024) {
  let head = '';
  let tail = '';
  let dropped = 0;
  return {
    push(chunk: string): void {
      if (head.length < headMax) {
        const room = headMax - head.length;
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
        if (!chunk) return;
      }
      tail += chunk;
      if (tail.length > tailMax) {
        dropped += tail.length - tailMax;
        tail = tail.slice(tail.length - tailMax);
      }
    },
    text(): string {
      if (!dropped) return head + tail;
      return `${head}\n…[${dropped.toLocaleString()} chars of output dropped from the middle — head and tail kept]…\n${tail}`;
    },
  };
}

/** Extensions we have already told the model have no language server. */
const announcedNoLsp = new Set<string>();

/** Process-group killers for bash commands currently running. */
const liveBashChildren = new Set<(signal: NodeJS.Signals) => void>();

/**
 * Kill every bash command this process started.
 *
 * Called on user interrupt. The tool promises still settle on their own — the
 * child dies, `close` fires, the result comes back as a failure — so nothing is
 * left dangling and no caller needs to special-case this.
 */
export function killRunningBashCommands(): number {
  const targets = [...liveBashChildren];
  for (const kill of targets) {
    try { kill('SIGTERM'); } catch { /* already gone */ }
  }
  // Escalate. A process that ignores SIGTERM — a shell trapping it, a test
  // runner mid-teardown — would otherwise keep the interrupt from meaning
  // anything, which is the whole complaint this fixes. Anything still
  // registered after the grace period is still alive.
  if (targets.length > 0) {
    setTimeout(() => {
      for (const kill of targets) {
        if (!liveBashChildren.has(kill)) continue;  // settled on its own
        try { kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 2_000).unref?.();
  }
  return targets.length;
}

/**
 * Apply a single edit (exact-match → fuzzy whitespace fallback) to `content`,
 * returning the new content + match count, or a typed error. Pure function —
 * does no I/O. Shared by edit_file and multi_edit so both speak the same
 * matching dialect.
 */
type EditApplyResult =
  | { ok: true; updated: string; matchCount: number }
  | { ok: false; error: string };

/**
 * Collapse runs of spaces/tabs to one space and CRLF to LF, while recording
 * where each output character came from.
 *
 * The map is what lets a fuzzy match be applied to the ORIGINAL text: find the
 * needle in normalized space, then translate the offsets back. Without it you
 * can only answer "is it in there somewhere", which is exactly how the count
 * and the location came to disagree.
 */
export function normalizeWithMap(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\r' && s[i + 1] === '\n') continue; // CRLF → LF
    if (ch === ' ' || ch === '\t') {
      const runStart = i;
      while (i + 1 < s.length && (s[i + 1] === ' ' || s[i + 1] === '\t')) i++;
      text += ' ';
      map.push(runStart);
      continue;
    }
    text += ch;
    map.push(i);
  }
  return { text, map };
}

/** Drop leading indentation from every line, for indentation-blind comparison. */
const deindent = (s: string) => s.split('\n').map((l) => l.trimStart()).join('\n');

/** `read_file` returns numbered lines ("   12  code"). A model that copies from
 *  that output brings the numbers with it, and every match then fails. */
const LINE_NUMBERED = /^\s*\d+\s\s/;
const stripLineNumbers = (s: string) =>
  s.split('\n').map((l) => l.replace(LINE_NUMBERED, '')).join('\n');

/** Leading whitespace of a line. */
const indentOf = (line: string) => /^[ \t]*/.exec(line)?.[0] ?? '';

export interface DeindentedMatch {
  startLine: number;
  endLine: number;
  /**
   * The indentation difference between the needle and the file, as a string.
   *
   * With `dedent: false` it is ADDED to each replacement line (the file is more
   * indented than the needle). With `dedent: true` it is REMOVED from each
   * (the needle is more indented than the file).
   */
  indentDelta: string;
  /** True when indentDelta must be stripped rather than prepended. */
  dedent: boolean;
}

/**
 * Find regions matching `oldStr` when leading indentation is ignored.
 *
 * Only lines that are non-blank on both sides are compared, and the whole
 * needle must line up — this is "the same code, indented differently", not a
 * fuzzy similarity search.
 */
export function findDeindentedMatches(content: string, oldStr: string): DeindentedMatch[] {
  const needle = oldStr.split('\n');
  // A trailing newline in the needle produces an empty last element that would
  // never match a real line; drop it and let the join handle the boundary.
  while (needle.length > 1 && needle[needle.length - 1].trim() === '') needle.pop();
  if (needle.length === 0 || needle.every((l) => l.trim() === '')) return [];

  const lines = content.split('\n');
  const out: DeindentedMatch[] = [];
  for (let i = 0; i + needle.length <= lines.length; i++) {
    let allMatch = true;
    for (let j = 0; j < needle.length; j++) {
      const a = needle[j].trim();
      const b = lines[i + j].trim();
      // Compare with whitespace runs collapsed so this stays a superset of the
      // normal fuzzy match rather than a stricter, differently-behaving one.
      if (normalizeWithMap(a).text !== normalizeWithMap(b).text) { allMatch = false; break; }
    }
    if (!allMatch) continue;

    // Every line must be off by the SAME amount. A needle that flattened the
    // region's relative indentation cannot be faithfully restored — re-indenting
    // it uniformly would rewrite the block's structure, which in Python is a
    // behaviour change and everywhere else is an ugly diff nobody asked for.
    // Those fall through to describeMiss, which quotes the exact text instead.
    // Both directions are handled. read_file prints numbered lines
    // ("   31      case 'x':"), so a model rebuilding the original strips a
    // prefix by eye: strip too much and the needle is UNDER-indented, strip too
    // little and it is OVER-indented. Only the first used to be absorbed, and
    // the second — the likelier slip, since leaving spaces behind is easier than
    // eating real ones — fell through to describeMiss, which located the match
    // and then handed it back for the model to retry. That round-trip was the
    // largest avoidable cost in the harness eval.
    let delta: string | null = null;
    let dedent = false;
    let uniform = true;
    for (let j = 0; j < needle.length; j++) {
      if (needle[j].trim() === '') continue;
      const fileIndent = indentOf(lines[i + j]);
      const needleIndent = indentOf(needle[j]);

      let d: string;
      let thisDedent: boolean;
      if (fileIndent.startsWith(needleIndent)) {
        d = fileIndent.slice(needleIndent.length);
        thisDedent = false;
      } else if (needleIndent.startsWith(fileIndent)) {
        d = needleIndent.slice(fileIndent.length);
        thisDedent = true;
      } else {
        // Neither is a prefix of the other — tabs vs spaces, say. Re-indenting
        // would be a guess about which the file wants.
        uniform = false;
        break;
      }

      // An empty delta is direction-agnostic, so it must not pin the direction
      // for the lines that follow.
      if (d === '') continue;
      if (delta === null) { delta = d; dedent = thisDedent; continue; }
      if (d !== delta || thisDedent !== dedent) { uniform = false; break; }
    }
    if (!uniform) continue;
    out.push({ startLine: i, endLine: i + needle.length - 1, indentDelta: delta ?? '', dedent });
  }
  return out;
}

/**
 * How much more indented `matched` is than `needle`, if it is uniformly so.
 *
 * Returns '' when they already agree, or when the difference is not the same on
 * every line — an uneven difference means the needle did not preserve the
 * block's structure, and re-indenting it uniformly would rewrite that structure
 * rather than restore it.
 */
export function uniformIndentDelta(matched: string, needle: string): IndentOp {
  const a = matched.split('\n');
  const b = needle.split('\n');
  while (b.length > 1 && b[b.length - 1].trim() === '') b.pop();
  if (a.length !== b.length) return NO_INDENT_SHIFT;
  let delta: string | null = null;
  let dedent = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].trim() === '' || b[i].trim() === '') continue;
    const ai = indentOf(a[i]);
    const bi = indentOf(b[i]);

    // Both directions. The needle can be indented LESS than the file (the model
    // stripped read_file's line numbers and took real spaces with them) or MORE
    // (it left some behind). Only the first used to be corrected; the second
    // returned '' and wrote new_string verbatim, silently pushing the region to
    // the model's deeper indentation.
    let d: string;
    let thisDedent: boolean;
    if (ai.startsWith(bi)) { d = ai.slice(bi.length); thisDedent = false; }
    else if (bi.startsWith(ai)) { d = bi.slice(ai.length); thisDedent = true; }
    else return NO_INDENT_SHIFT;   // tabs vs spaces — picking one would be a guess

    if (d === '') continue;        // no shift on this line, so it pins no direction
    if (delta === null) { delta = d; dedent = thisDedent; continue; }
    if (d !== delta || thisDedent !== dedent) return NO_INDENT_SHIFT;
  }
  return delta === null ? NO_INDENT_SHIFT : { indent: delta, dedent };
}

/**
 * An indentation shift between a needle and the region it matched.
 *
 * `dedent` says which way: false means add `indent` to the replacement, true
 * means strip it. An empty `indent` means no shift at all.
 */
export interface IndentOp {
  indent: string;
  dedent: boolean;
}

export const NO_INDENT_SHIFT: IndentOp = { indent: '', dedent: false };

/** Re-indent every non-blank line of a replacement by `delta`. */
export function reindent(text: string, delta: string): string {
  if (!delta) return text;
  return text.split('\n').map((l) => (l.trim() === '' ? l : delta + l)).join('\n');
}

/**
 * Strip `delta` from the front of every non-blank line, or refuse.
 *
 * Used when the needle was MORE indented than the file, so the replacement is
 * too. Returns null unless every non-blank line genuinely starts with `delta` —
 * if even one does not, stripping would eat real characters or dedent past
 * column 0, and in Python that is a behaviour change rather than a cosmetic
 * one. Refusing falls through to describeMiss, which is the old behaviour: a
 * wasted turn, but never a corrupted file.
 */
export function dedentBy(text: string, delta: string): string | null {
  if (!delta) return text;
  const lines = text.split('\n');
  for (const l of lines) {
    if (l.trim() === '') continue;
    if (!l.startsWith(delta)) return null;
  }
  return lines.map((l) => (l.trim() === '' ? l : l.slice(delta.length))).join('\n');
}

/**
 * Explain a miss well enough that the next attempt succeeds.
 *
 * "old_string not found — read the file first" is a dead end when the model has
 * already read the file: it says the text is absent without saying what IS
 * there, so the retry is another guess. In the harness eval this was the second
 * largest source of tool failures, and one run flailed for 15 turns before loop
 * detection stopped it.
 *
 * So before giving up, check the two ways a needle is usually almost-right and
 * hand back the file's EXACT bytes for the region. Nothing is applied on the
 * model's behalf — a guess about intent could silently corrupt code — but the
 * information needed to get it right next time is in the message.
 */
export function describeMiss(content: string, oldStr: string, relPath: string): string {
  const base = `old_string not found in ${relPath}.`;
  const lines = content.split('\n');

  // 1. Did the model paste read_file's line numbers along with the code?
  const stripped = stripLineNumbers(oldStr);
  if (stripped !== oldStr && normalizeWithMap(content).text.includes(normalizeWithMap(stripped).text)) {
    return `${base} It looks like the line numbers from read_file were included. ` +
      `Send just the code:\n${stripped}`;
  }

  // 2. Does it match if indentation is ignored? Then quote the real thing.
  const target = deindent(normalizeWithMap(oldStr).text).trim();
  if (target) {
    const needleLines = oldStr.split('\n').length;
    for (let i = 0; i + needleLines <= lines.length; i++) {
      const window = lines.slice(i, i + needleLines).join('\n');
      if (deindent(normalizeWithMap(window).text).trim() === target) {
        return `${base} The same code is at line ${i + 1} with different indentation. ` +
          `Use this text exactly:\n${window}`;
      }
    }
  }

  // 3. Fall back to showing where the first line seems to live.
  const firstLine = oldStr.split('\n')[0].trim();
  const lineIdx = firstLine ? lines.findIndex((l) => l.trim().includes(firstLine)) : -1;
  // Show AS MUCH of the real region as the needle was long, not a fixed four
  // lines. Measured on a real replay task: an 8-line needle missed in a 73-line
  // HTML file and the model was shown four lines of context — not enough to
  // reconstruct what to send, so the next attempt missed too. The whole point of
  // this message is that the model can copy the answer out of it.
  const span = Math.min(40, Math.max(6, oldStr.split('\n').length + 4));
  const start = Math.max(0, lineIdx - 2);
  const hint = lineIdx >= 0
    ? `\nThe file actually reads (copy this exactly, including indentation):\n${lines
        .slice(start, start + span)
        .map((l, i) => `  ${start + i + 1}: ${l}`)
        .join('\n')}`
    : '';
  return `${base} Read the file first to get the exact content.${hint}`;
}

/**
 * Levenshtein distance, bounded.
 *
 * Only ever called on single lines, and only to score how close two lines are —
 * so long lines are clipped rather than paid for in full. Two rows, not a full
 * matrix: the distance is all we need, never the alignment.
 */
export function levenshtein(a: string, b: string, cap = 400): number {
  const s1 = a.length > cap ? a.slice(0, cap) : a;
  const s2 = b.length > cap ? b.slice(0, cap) : b;
  if (s1 === s2) return 0;
  if (!s1.length) return s2.length;
  if (!s2.length) return s1.length;
  let prev = new Array<number>(s2.length + 1);
  let curr = new Array<number>(s2.length + 1);
  for (let j = 0; j <= s2.length; j++) prev[j] = j;
  for (let i = 1; i <= s1.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[s2.length];
}

/** Minimum middle-line similarity for a block-anchor match to be accepted. */
const BLOCK_ANCHOR_THRESHOLD = 0.7;
/** Two candidates closer together than this are ambiguous, and we refuse. */
const BLOCK_ANCHOR_TIE = 0.05;

export interface BlockAnchorMatch {
  startLine: number;
  endLine: number;
  similarity: number;
}

/**
 * Find a block by its FIRST and LAST line, tolerating a wrong middle.
 *
 * This is the failure every other strategy here misses. Exact, whitespace-
 * normalized and de-indented matching all require the model to reproduce the
 * region character-for-character modulo whitespace; they recover a formatting
 * slip and nothing else. But a 3B-active model routinely gets the SHAPE right
 * and one line wrong — a paraphrased comment, a renamed local, a blank line
 * dropped — and every one of those costs a full round trip to discover.
 *
 * So: anchor on the first and last line (which models reproduce reliably,
 * because that is where they were told to cut), allow the block length to differ
 * by ±25%, and score the middle by line-wise Levenshtein similarity.
 *
 * Two deliberate departures from the design this is modelled on:
 *  - a tie between two candidate blocks is REFUSED, not resolved by taking the
 *    max. Editing the wrong block of code is far worse than one more round trip,
 *    and "the two best candidates are equally good" is exactly the case where a
 *    similarity score carries no information about which one was meant;
 *  - anchors must be non-empty after trimming, so a needle padded with blank
 *    lines cannot anchor on nothing and match anywhere.
 */
export function findBlockAnchorMatch(content: string, oldStr: string): BlockAnchorMatch | null {
  // Kill switch, so this strategy can be A/B'd against itself IN THE SAME BUILD.
  // Comparing eval scores across commits is not a measurement — the harness
  // changes underneath — so every new mechanism here gets a switch and is
  // measured by running the same binary twice.
  if (process.env.VCODE_NO_BLOCK_ANCHOR === '1') return null;
  const needle = oldStr.split('\n');
  if (needle.length > 1 && needle[needle.length - 1] === '') needle.pop();
  if (needle.length < 3) return null; // no middle to be wrong about

  const first = needle[0].trim();
  const last = needle[needle.length - 1].trim();
  if (!first || !last) return null;

  const lines = content.split('\n');
  const size = needle.length;
  const maxDelta = Math.max(1, Math.floor(size * 0.25));
  const middle = needle.slice(1, -1);

  const candidates: BlockAnchorMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== first) continue;
    for (let j = i + size - 1 - maxDelta; j <= i + size - 1 + maxDelta; j++) {
      if (j <= i || j >= lines.length) continue;
      if (lines[j].trim() !== last) continue;

      const found = lines.slice(i + 1, j);
      const linesToCheck = Math.max(middle.length, found.length);
      let similarity = 1;
      if (linesToCheck > 0) {
        similarity = 0;
        for (let k = 0; k < linesToCheck; k++) {
          const a = (middle[k] ?? '').trim();
          const b = (found[k] ?? '').trim();
          const maxLen = Math.max(a.length, b.length);
          const lineScore = maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
          similarity += lineScore / linesToCheck;
        }
      }
      if (similarity >= BLOCK_ANCHOR_THRESHOLD) {
        candidates.push({ startLine: i, endLine: j, similarity });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.similarity - a.similarity);
  if (candidates.length > 1 && candidates[0].similarity - candidates[1].similarity < BLOCK_ANCHOR_TIE) {
    return null; // ambiguous — refuse rather than edit the wrong block
  }
  return candidates[0];
}

export function applySingleEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
  relPathForErrors: string,
): EditApplyResult {
  const occurrences = content.split(oldStr).length - 1;

  if (occurrences > 0) {
    if (!replaceAll && occurrences > 1) {
      return { ok: false, error: `old_string found ${occurrences} times in ${relPathForErrors} — it must be unique. Include more surrounding context, or set replace_all=true.` };
    }
    const updated = replaceAll ? content.replaceAll(oldStr, newStr) : content.replace(oldStr, newStr);
    return { ok: true, updated, matchCount: occurrences };
  }

  // ── Fuzzy whitespace match ──────────────────────────────────────────────────
  //
  // Counting and locating MUST be the same operation. They used to differ:
  // occurrences were counted with a substring search over the whole normalized
  // file, but the position was then found by requiring a window of exactly
  // `oldStr`'s line count to normalize to the *entire* needle. Any old_string
  // that started or ended mid-line — different indentation on the first line,
  // the commonest case there is — was counted as present and then reported as
  // "Whitespace-fuzzy match found but could not locate exact position", which
  // is a message telling the model to retry the thing it just did.
  //
  // It was the single largest source of tool failures in the harness eval:
  // 4 of 27 calls on one task. Now one search produces both the count and the
  // exact spans, so the two cannot disagree and that error no longer exists.
  const { text: normContent, map } = normalizeWithMap(content);
  const normOld = normalizeWithMap(oldStr).text;

  const spans: Array<{ start: number; end: number }> = [];
  for (let from = 0; ;) {
    const idx = normContent.indexOf(normOld, from);
    if (idx === -1) break;
    spans.push({
      start: map[idx],
      // Where the character AFTER the match begins in the original text, so a
      // run of whitespace collapsed into the match is replaced along with it.
      end: idx + normOld.length < map.length ? map[idx + normOld.length] : content.length,
    });
    from = idx + normOld.length;
  }

  if (spans.length === 0) {
    // ── Last resort: match ignoring leading indentation ────────────────────
    //
    // read_file prints numbered lines ("   31      case 'x':"), so a model
    // reconstructing the original has to strip exactly the right prefix. Get it
    // slightly wrong and the leading whitespace no longer matches, which is why
    // "old_string not found" was the most common tool failure in the eval —
    // repeatedly, on files the model had just read.
    //
    // Applied only when EXACTLY ONE region matches ignoring indentation, and
    // new_string is re-indented by the same delta so the file's own indentation
    // wins rather than the model's guess. Ambiguity is still refused: this
    // absorbs a formatting slip, it does not guess at intent.
    const indentMatches = findDeindentedMatches(content, oldStr);
    if (indentMatches.length === 1) {
      const { startLine, endLine, indentDelta, dedent } = indentMatches[0];
      const replacement = dedent ? dedentBy(newStr, indentDelta) : reindent(newStr, indentDelta);
      // dedentBy refuses when the replacement does not uniformly carry the
      // indentation being removed. Refusing means falling through to
      // describeMiss rather than writing a file we had to guess at.
      if (replacement !== null) {
        const lines = content.split('\n');
        const updated = [...lines.slice(0, startLine), ...replacement.split('\n'), ...lines.slice(endLine + 1)].join('\n');
        return { ok: true, updated, matchCount: 1 };
      }
    }

    // ── Final resort: anchor on the first and last line, tolerate the middle ──
    //
    // Everything above requires the model to have reproduced the region
    // faithfully modulo whitespace. This is the one strategy that survives a
    // WRONG middle line, which is the characteristic mistake of a small model
    // working from a file it read several turns ago. Single edits only:
    // a fuzzy replace_all would apply an approximate match repeatedly, and one
    // wrong site is a bug the model cannot see.
    if (!replaceAll) {
      const block = findBlockAnchorMatch(content, oldStr);
      if (block) {
        const lines = content.split('\n');
        // The file's indentation wins over the model's, same as the path above.
        const delta = uniformIndentDelta(
          lines.slice(block.startLine, block.endLine + 1).join('\n'),
          oldStr,
        );
        const shifted = delta.indent
          ? (delta.dedent ? dedentBy(newStr, delta.indent) : reindent(newStr, delta.indent))
          : null;
        const replacement = (shifted ?? newStr).split('\n');
        const updated = [
          ...lines.slice(0, block.startLine),
          ...replacement,
          ...lines.slice(block.endLine + 1),
        ].join('\n');
        return { ok: true, updated, matchCount: 1 };
      }
    }

    return { ok: false, error: describeMiss(content, oldStr, relPathForErrors) };
  }

  if (!replaceAll && spans.length > 1) {
    return { ok: false, error: `old_string found ${spans.length} times (with whitespace normalization) — include more context.` };
  }

  // Splice back to front so earlier offsets stay valid. The old code called
  // content.replace(actualOld, newStr), which replaces only the FIRST match
  // even when replace_all was set — a silent second bug on this same path.
  const targets = replaceAll ? spans : spans.slice(0, 1);
  let updated = content;
  for (const { start, end } of [...targets].reverse()) {
    // Preserve the FILE's indentation, not the model's.
    //
    // Whitespace-insensitive matching means the needle can be indented
    // differently from the region it matched — and writing new_string verbatim
    // then silently reformats that region to the model's indentation. On a
    // multi-line replacement inside a nested block that is a real, invisible
    // reformat, and in Python it changes what the code means.
    // The span can begin mid-line, so the first line's real indentation is not
    // inside the slice. Rebuild it from the line start — and only re-indent at
    // all when everything before the match on that line is whitespace, since a
    // match starting after real code (`const |x = 1`) must not have indentation
    // spliced into the middle of the line.
    const lineStart = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const prefix = content.slice(lineStart, start);
    const atLineStart = /^[ \t]*$/.test(prefix);
    const op = atLineStart
      ? uniformIndentDelta(prefix + content.slice(start, end), oldStr)
      : NO_INDENT_SHIFT;
    // When a dedent cannot be applied cleanly — some replacement line does not
    // carry the indentation being stripped — write new_string verbatim, which is
    // what this path did for every dedent before. Cosmetically wrong beats
    // turning an edit that used to succeed into a failure.
    const shifted = op.indent
      ? (op.dedent ? dedentBy(newStr, op.indent) : reindent(newStr, op.indent))
      : null;
    updated = updated.slice(0, start) + (shifted ?? newStr) + updated.slice(end);
  }
  return { ok: true, updated, matchCount: targets.length };
}

function createEditFileTool(ignoreManager?: IgnoreManager, fileTracker?: FileTracker, lspManager?: LspManager): ToolDef {
  return {
    name: 'edit_file',
    description: 'Edit a file by replacing a string match. You must read_file it first in this session — editing an unread file is refused. Provide old_string (copied exactly from the file, without read_file\'s line numbers) and new_string. By default old_string must be unique; set replace_all=true to replace every occurrence.',
    schema: z.object({
      path: z.string().describe('File path to edit'),
      old_string: z.string().describe('Exact text from the file, copied without the line numbers read_file prints. Whitespace runs may differ; indentation must be present.'),
      new_string: z.string().describe('The replacement string'),
      replace_all: z.boolean().optional().default(false).describe('Replace all occurrences instead of requiring uniqueness'),
    }),
    execute: async (params) => {
      try {
        const filePath = resolve(params.path as string);
        const blocked = ignoreManager?.getBlockedReason(filePath);
        if (blocked) return fail(`Access blocked by .veepeignore (${blocked}): ${filePath}`);
        if (fileTracker) {
          const stale = fileTracker.checkFresh(filePath);
          if (stale) return fail(stale);
        }
        const content = await readFile(filePath, 'utf-8');
        const oldStr = params.old_string as string;
        const newStr = params.new_string as string;
        const replaceAll = params.replace_all as boolean;
        const relPath = relative(process.cwd(), filePath);

        const result = applySingleEdit(content, oldStr, newStr, replaceAll, relPath);
        if (!result.ok) return fail(result.error);

        await writeFile(filePath, result.updated, 'utf-8');
        fileTracker?.recordRead(filePath);

        const oldLines = oldStr.split('\n');
        const newLines = newStr.split('\n');
        const diffLines: string[] = [`Edited ${relPath}${result.matchCount > 1 ? ` (${result.matchCount} replacements)` : ''}:`];
        for (const line of oldLines.slice(0, 10)) diffLines.push(`- ${line}`);
        if (oldLines.length > 10) diffLines.push(`  ... (${oldLines.length - 10} more lines)`);
        for (const line of newLines.slice(0, 10)) diffLines.push(`+ ${line}`);
        if (newLines.length > 10) diffLines.push(`  ... (${newLines.length - 10} more lines)`);
        const summary = diffLines.join('\n');
        const diagBlock = await appendLspDiagnostics(lspManager, filePath);
        return ok(summary + diagBlock);
      } catch (err) {
        return fail(`Cannot edit file: ${(err as Error).message}`);
      }
    },
  };
}

function createMultiEditTool(ignoreManager?: IgnoreManager, fileTracker?: FileTracker, lspManager?: LspManager): ToolDef {
  return {
    name: 'multi_edit',
    description: 'Apply multiple edits to a single file, atomically. You must read_file it first in this session. Every edit is checked against the running content and ALL failures are reported together; if any would fail, nothing is written. Use for multi-step refactors on one file to avoid partial writes.',
    schema: z.object({
      path: z.string().describe('File path to edit'),
      edits: jsonish(z.array(z.object({
        old_string: z.string().describe('Exact string to find and replace'),
        new_string: z.string().describe('Replacement string'),
        replace_all: z.boolean().optional().default(false).describe('Replace all occurrences instead of requiring uniqueness'),
      })).min(1)).describe('List of edits to apply in order against the running content'),
    }),
    execute: async (params) => {
      try {
        const filePath = resolve(params.path as string);
        const blocked = ignoreManager?.getBlockedReason(filePath);
        if (blocked) return fail(`Access blocked by .veepeignore (${blocked}): ${filePath}`);
        if (fileTracker) {
          const stale = fileTracker.checkFresh(filePath);
          if (stale) return fail(stale);
        }

        const original = await readFile(filePath, 'utf-8');
        const relPath = relative(process.cwd(), filePath);
        const edits = params.edits as Array<{ old_string: string; new_string: string; replace_all?: boolean }>;

        // Phase 1: validate-and-simulate. Walk edits in order against the
        // running content; bail on the first failure WITHOUT writing.
        // Every edit is checked, not just up to the first failure. Bailing early
        // reported one broken op at a time, so a call with two bad edits cost
        // two full retries to learn about the second — and the whole batch was
        // rewritten each round. Writing nothing unless ALL succeed is kept: a
        // half-applied file is worse than a rejected call.
        let working = original;
        const matches: number[] = [];
        const failures: string[] = [];
        for (let i = 0; i < edits.length; i++) {
          const e = edits[i];
          const r = applySingleEdit(working, e.old_string, e.new_string, e.replace_all ?? false, relPath);
          if (!r.ok) {
            failures.push(`  op ${i}: ${r.error}`);
            continue;
          }
          working = r.updated;
          matches.push(r.matchCount);
        }
        if (failures.length > 0) {
          const okCount = edits.length - failures.length;
          return fail(
            `multi_edit: ${failures.length} of ${edits.length} edits failed. No changes written.\n` +
            `${failures.join('\n')}\n` +
            (okCount > 0
              ? `The other ${okCount} edit${okCount === 1 ? '' : 's'} matched — resend the whole batch with the failing one${failures.length === 1 ? '' : 's'} corrected.`
              : `Re-read the file and retry.`) +
            (failures.length > 1
              ? `\nNote: later ops were checked against the file without the failed edits applied, so a message may change once the earlier ones are fixed.`
              : ''),
          );
        }

        // Phase 2: commit. Single write of the fully-simulated content.
        await writeFile(filePath, working, 'utf-8');
        fileTracker?.recordRead(filePath);

        const summary = matches.map((m, i) => `  op ${i}: ${m} replacement${m === 1 ? '' : 's'}`).join('\n');
        const head = `multi_edit: applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${relPath}\n${summary}`;
        const diagBlock = await appendLspDiagnostics(lspManager, filePath);
        return ok(head + diagBlock);
      } catch (err) {
        return fail(`Cannot multi_edit file: ${(err as Error).message}`);
      }
    },
  };
}

function createGlobTool(ignoreManager?: IgnoreManager): ToolDef {
  return {
    name: 'glob',
    description: 'Find files matching a glob pattern. Use patterns like "**/*.ts", "src/**/*.js", "*.json". Returns matching file paths.',
    schema: z.object({
      pattern: z.string().describe('Glob pattern to match files (e.g. "**/*.ts", "src/**/*.js")'),
      cwd: z.string().optional().describe('Directory to search in (defaults to working directory)'),
    }),
    execute: async (params) => {
      try {
        const cwd = resolve((params.cwd as string) || process.cwd());
        const rawMatches = await globFn(params.pattern as string, {
          cwd,
          ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', '.next/**'],
          nodir: true,
        });

        // Filter out .veepeignore-blocked paths
        const matches = ignoreManager
          ? rawMatches.filter(m => !ignoreManager.isBlocked(resolve(cwd, m)))
          : rawMatches;

        if (matches.length === 0) {
          return ok('No files matched the pattern.');
        }

        const sorted = matches.sort();
        const output = sorted.length > 100
          ? sorted.slice(0, 100).join('\n') + `\n... and ${sorted.length - 100} more`
          : sorted.join('\n');

        return ok(`Found ${matches.length} files:\n${output}`);
      } catch (err) {
        return fail(`Glob failed: ${(err as Error).message}`);
      }
    },
  };
}

function createGrepTool(ignoreManager?: IgnoreManager): ToolDef {
  return {
    name: 'grep',
    description: 'Search file contents using a regex pattern. Returns matching lines with file paths and line numbers. Great for finding where functions, classes, or patterns are defined or used.',
    schema: z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      path: z.string().optional().describe('File or directory to search in (defaults to working directory)'),
      include: z.string().optional().describe('File pattern to include (e.g. "*.ts", "*.py")'),
      max_results: z.number().optional().describe('Maximum number of results (default 50)'),
    }),
    execute: async (params) => {
      try {
        const searchPath = resolve((params.path as string) || '.');
        // Block grep on a directly specified sensitive file
        if (params.path) {
          const blocked = ignoreManager?.getBlockedReason(searchPath);
          if (blocked) return fail(`Access blocked by .veepeignore (${blocked}): ${searchPath}`);
        }
        const include = params.include as string | undefined;
        const maxResults = (params.max_results as number) || 50;
        const pattern = params.pattern as string;

        // Use ripgrep if available, otherwise grep — with arg arrays to prevent injection
        const hasRg = (() => {
          try { execSync('which rg', { stdio: 'pipe' }); return true; } catch { return false; }
        })();

        let bin: string;
        let args: string[];
        if (hasRg) {
          bin = 'rg';
          args = ['-n', '--max-count', String(maxResults), '--no-heading'];
          if (include) args.push('--glob', include);
          args.push('--', pattern, searchPath);
        } else {
          bin = 'grep';
          args = ['-rn', `--max-count=${maxResults}`];
          if (include) args.push(`--include=${include}`);
          args.push('-E', '--', pattern, searchPath);
        }

        const output = execFileSync(bin, args, {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: SYNC_CMD_TIMEOUT_MS,
        }).trim();

        if (!output) return ok('No matches found.');

        const lines = output.split('\n');
        const result = lines.length > maxResults
          ? lines.slice(0, maxResults).join('\n') + `\n... (truncated at ${maxResults} results)`
          : output;

        return ok(`${lines.length} matches:\n${result}`);
      } catch (err) {
        const error = err as { status?: number; message?: string; stdout?: string };
        // grep returns exit code 1 for no matches
        if (error.status === 1) return ok('No matches found.');
        return fail(`Search failed: ${error.message || 'Unknown error'}`);
      }
    },
  };
}

function createBashTool(fileTracker?: FileTracker): ToolDef {
  return {
    name: 'bash',
    description: 'Execute a shell command and return its output. Use for running builds, tests, package managers, system commands, or any operation that needs shell access.',
    schema: z.object({
      command: z.string().describe('The shell command to execute'),
      cwd: z.string().optional().describe('Working directory for the command'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default 120000)'),
    }),
    execute: async (params) => {
      return new Promise<ToolResult>((res) => {
        const cwd = resolve((params.cwd as string) || process.cwd());
        const timeout = (params.timeout as number) || 120_000;
        const command = params.command as string;
        // Heuristic: forget tracker entries for any tracked file whose path
        // appears in the command string. This catches `sed -i foo.ts`,
        // `prettier --write a.ts`, `mv x y`, etc. without false-positiving on
        // pure-read commands like `git status` or `npm test`.
        if (fileTracker) {
          forgetReferencedPaths(fileTracker, command, cwd);
        }

        // `detached` puts the command in its own process group so we can kill
        // the whole tree. Without it a timeout only reaps the `bash -c` child
        // and any grandchildren keep running — and keep the stdout pipe open.
        const child = spawn('bash', ['-c', params.command as string], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
          env: { ...process.env },
        });

        // TRUNCATE IN THE MIDDLE, NOT THE TAIL.
        //
        // This kept the first 512 KB and discarded everything after it — which,
        // for the output that actually matters here, throws away the answer. A
        // build log, a test run and a stack trace all put the diagnosis at the
        // END; a compile that emits 600 KB of progress before the one error line
        // was reported to the model as 512 KB of progress and nothing else. Keep
        // both ends and say what was dropped in between.
        const stdoutBuf = boundedStream();
        const stderrBuf = boundedStream();
        child.stdout.on('data', (data: Buffer) => stdoutBuf.push(data.toString()));
        child.stderr.on('data', (data: Buffer) => stderrBuf.push(data.toString()));

        // The tool never feeds the command stdin, so close it immediately: a
        // command that reads stdin gets EOF and fails fast instead of blocking
        // until the timeout. Guard the stream — an already-exited child makes
        // this raise EPIPE as an async 'error' event, which would be fatal.
        child.stdin.on('error', () => { /* command exited without reading stdin */ });
        child.stdin.end();

        let settled = false;
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          liveBashChildren.delete(killTree);
          clearTimeout(hardTimer);
          if (graceTimer) clearTimeout(graceTimer);
          // Stop holding the pipes so node isn't kept alive by a survivor.
          child.stdout.destroy();
          child.stderr.destroy();
          res(result);
        };
        const compose = () => {
          const out = stdoutBuf.text();
          const err = stderrBuf.text();
          return out + (err ? `\n[stderr]\n${err}` : '');
        };

        // Kill the whole process group. Negative pid = the group led by `child`.
        const killTree = (signal: NodeJS.Signals) => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, signal);
          } catch {
            // Group already gone, or we lost the race — nothing to reap.
          }
        };
        // Ctrl+C used to stop the model stream and nothing else: a running
        // `npm test` or a hung `curl` kept the terminal hostage for its whole
        // timeout, with the interrupt visibly ignored. Registering here lets the
        // agent's abort reach the process group that is actually blocking.
        liveBashChildren.add(killTree);

        const hardTimer = setTimeout(() => {
          killTree('SIGKILL');
          finish(fail(
            `Command timed out after ${timeout}ms and was killed (process group terminated).\n${compose().trim()}`,
          ));
        }, timeout);

        // 'exit' means the command itself finished. 'close' additionally waits
        // for stdio EOF, which a backgrounded grandchild can hold open
        // indefinitely (`npm run dev &`, a spawned server). Prefer 'close' so
        // output is complete, but never wait on it for more than a grace
        // period after the command is already gone.
        //
        // THE EXIT CODE IS THE POINT OF THIS HANDLER, AND IT USED TO BE THROWN
        // AWAY. `child.on('exit', () => ...)` discarded its `code` argument and
        // the grace path called `ok(...)` unconditionally, so any command that
        // left a background process — a test run that starts a watcher, a build
        // that spawns a dev server, anything with a trailing `&` — reported
        // SUCCESS no matter how it exited. Downstream that is worse than a
        // wrong answer: `addToolResult(..., success=true)` keeps the error
        // count flat, the self-repair guard treats the turn as verified, and
        // the model reads a passing build. Verified with a lingering child and
        // `exit 3`: success=true before, success=false after.
        child.on('exit', (code, signal) => {
          if (settled || graceTimer) return;
          graceTimer = setTimeout(() => {
            const out = compose().trim();
            const note =
              '(note: the command exited but left a background process holding its output stream; ' +
              'it is still running and detached from this tool call)';
            // A signal death is a failure too — SIGKILL from an OOM killer is
            // not a passing test run.
            if (code === 0 && !signal) {
              finish(ok((out ? out + '\n' : '') + note));
            } else {
              const how = signal ? `killed by ${signal}` : `Exit code ${code}`;
              finish(fail(`${how}\n${out}\n${note}`.trim()));
            }
          }, OUTPUT_FLUSH_GRACE_MS);
        });

        child.on('close', (code, signal) => {
          const output = compose();
          if (signal) {
            finish(fail(`Killed by ${signal}\n${output.trim()}`));
            return;
          }
          if (code === 0) {
            finish(ok(output.trim() || '(no output)'));
          } else {
            finish(fail(`Exit code ${code}\n${output.trim()}`));
          }
        });

        child.on('error', (err) => {
          finish(fail(`Command failed: ${err.message}`));
        });
      });
    },
  };
}

function createGitTool(): ToolDef {
  return {
    name: 'git',
    description: 'Run git commands. Supports all git operations: status, diff, log, add, commit, branch, checkout, push, pull, etc.',
    schema: z.object({
      args: z.string().describe('Git arguments (e.g. "status", "diff --staged", "log --oneline -10")'),
      cwd: z.string().optional().describe('Repository directory'),
    }),
    execute: async (params) => {
      try {
        const cwd = resolve((params.cwd as string) || process.cwd());
        // Parse args string into array to avoid shell injection
        // Uses a simple split that respects quoted strings
        const argsStr = (params.args as string) || '';
        const gitArgs = parseArgs(argsStr);
        const output = execFileSync('git', gitArgs, {
          cwd,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: SYNC_CMD_TIMEOUT_MS,
        });
        return ok(output.trim() || '(no output)');
      } catch (err) {
        const error = err as { stderr?: string; message?: string };
        return fail(error.stderr?.trim() || error.message || 'git command failed');
      }
    },
  };
}

/** Parse a command string into an array, respecting quoted strings.
 *
 *  `quoted` tracks whether the current token contained a quoted section, so a
 *  deliberately empty argument survives. Testing truthiness of `current` alone
 *  silently dropped it: `commit -m ""` became `commit -m`, and git then failed
 *  on a missing message. */
export function parseArgs(str: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let inQuote: string | null = null;
  for (const ch of str) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      quoted = true;
    } else if (ch === ' ' || ch === '\t') {
      if (current || quoted) { args.push(current); current = ''; quoted = false; }
    } else {
      current += ch;
    }
  }
  if (current || quoted) args.push(current);
  return args;
}

function createGithubTool(): ToolDef {
  return {
    name: 'github',
    description: 'Interact with GitHub via the gh CLI. Manage repos, pull requests, issues, and releases. Actions: repo_create, repo_list, pr_create, pr_list, pr_view, pr_merge, pr_comment, pr_diff, pr_checks, issue_create, issue_list, issue_view, issue_comment, release_create, release_list.',
    schema: z.object({
      action: z.enum([
        'repo_create', 'repo_list',
        'pr_create', 'pr_list', 'pr_view', 'pr_merge', 'pr_comment', 'pr_diff', 'pr_checks',
        'issue_create', 'issue_list', 'issue_view', 'issue_comment',
        'release_create', 'release_list',
      ]).describe(
        'repo_create: create a new repo. repo_list: list your repos. ' +
        'pr_create: open a PR. pr_list: list PRs. pr_view: view PR details. pr_merge: merge a PR. pr_comment: comment on a PR. pr_diff: view PR diff. pr_checks: view PR CI status. ' +
        'issue_create: create an issue. issue_list: list issues. issue_view: view issue details. issue_comment: comment on an issue. ' +
        'release_create: create a release. release_list: list releases.',
      ),
      repo: z.string().optional().describe("Repository in owner/name format (e.g. 'vpontual/newsfeed'). Omit to use the repo in cwd."),
      title: z.string().optional().describe('Title for PR, issue, release, or new repo name'),
      body: z.string().optional().describe('Body/description for PR, issue, release, or comment text'),
      branch: z.string().optional().describe('Branch name for PR (head branch) or release tag'),
      base: z.string().optional().describe('Base branch for PR (default: repo default branch)'),
      number: z.number().optional().describe('PR or issue number (for view/merge/comment actions)'),
      labels: z.string().optional().describe('Comma-separated labels for PR or issue'),
      draft: z.boolean().optional().describe('Create PR as draft'),
      is_private: z.boolean().optional().describe('Create repo as private (default true)'),
      limit: z.number().optional().describe('Max results for list actions (default 20)'),
      cwd: z.string().optional().describe('Git repository directory'),
    }),
    execute: async (params) => {
      const action = params.action as string;
      const repo = params.repo as string | undefined;
      const title = params.title as string | undefined;
      const body = params.body as string | undefined;
      const branch = params.branch as string | undefined;
      const base = params.base as string | undefined;
      const number = params.number as number | undefined;
      const labels = params.labels as string | undefined;
      const draft = params.draft as boolean | undefined;
      const isPrivate = params.is_private as boolean | undefined;
      const limit = (params.limit as number) || 20;
      const cwd = resolve((params.cwd as string) || process.cwd());

      const rf = repo ? ['-R', repo] : [];

      function runGh(args: string[]): ToolResult {
        try {
          const output = execFileSync('gh', args, {
            cwd,
            encoding: 'utf-8',
            maxBuffer: 2 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30_000,
          });
          return ok(output.trim() || '(no output)');
        } catch (err) {
          const error = err as { stderr?: string; stdout?: string; message?: string };
          const out = [error.stdout, error.stderr ?? error.message].filter(Boolean).join('\n').trim();
          return fail(out || 'gh command failed');
        }
      }

      switch (action) {
        // ---- Repos ----
        case 'repo_create': {
          if (!title) return fail("Missing 'title' (repo name) for repo_create");
          const a = ['repo', 'create', title, isPrivate === false ? '--public' : '--private', '--confirm'];
          if (body) a.push('--description', body);
          return runGh(a);
        }
        case 'repo_list':
          return runGh(['repo', 'list', '--limit', String(limit)]);

        // ---- Pull Requests ----
        case 'pr_create': {
          if (!title) return fail("Missing 'title' for pr_create");
          const a = ['pr', 'create', '--title', title, ...rf];
          if (body) a.push('--body', body);
          if (branch) a.push('--head', branch);
          if (base) a.push('--base', base);
          if (labels) a.push('--label', labels);
          if (draft) a.push('--draft');
          return runGh(a);
        }
        case 'pr_list':
          return runGh(['pr', 'list', '--limit', String(limit), ...rf]);
        case 'pr_view': {
          if (!number) return fail("Missing 'number' for pr_view");
          return runGh(['pr', 'view', String(number), ...rf]);
        }
        case 'pr_merge': {
          if (!number) return fail("Missing 'number' for pr_merge");
          return runGh(['pr', 'merge', String(number), '--merge', ...rf]);
        }
        case 'pr_comment': {
          if (!number) return fail("Missing 'number' for pr_comment");
          if (!body) return fail("Missing 'body' for pr_comment");
          return runGh(['pr', 'comment', String(number), '--body', body, ...rf]);
        }
        case 'pr_diff': {
          if (!number) return fail("Missing 'number' for pr_diff");
          return runGh(['pr', 'diff', String(number), ...rf]);
        }
        case 'pr_checks': {
          if (!number) return fail("Missing 'number' for pr_checks");
          return runGh(['pr', 'checks', String(number), ...rf]);
        }

        // ---- Issues ----
        case 'issue_create': {
          if (!title) return fail("Missing 'title' for issue_create");
          const a = ['issue', 'create', '--title', title, ...rf];
          if (body) a.push('--body', body);
          if (labels) a.push('--label', labels);
          return runGh(a);
        }
        case 'issue_list':
          return runGh(['issue', 'list', '--limit', String(limit), ...rf]);
        case 'issue_view': {
          if (!number) return fail("Missing 'number' for issue_view");
          return runGh(['issue', 'view', String(number), ...rf]);
        }
        case 'issue_comment': {
          if (!number) return fail("Missing 'number' for issue_comment");
          if (!body) return fail("Missing 'body' for issue_comment");
          return runGh(['issue', 'comment', String(number), '--body', body, ...rf]);
        }

        // ---- Releases ----
        case 'release_create': {
          if (!branch) return fail("Missing 'branch' (tag name) for release_create");
          const a = ['release', 'create', branch, ...rf];
          if (title) a.push('--title', title);
          if (body) a.push('--notes', body);
          return runGh(a);
        }
        case 'release_list':
          return runGh(['release', 'list', '--limit', String(limit), ...rf]);

        default:
          return fail(`Unknown github action: ${action}`);
      }
    },
  };
}

function createListFilesTool(): ToolDef {
  return {
    name: 'list_files',
    description: 'List files and directories in a given path. Returns names with type indicators (/ for directories).',
    schema: z.object({
      path: z.string().optional().describe('Directory path to list (defaults to working directory)'),
      recursive: z.boolean().optional().describe('List recursively (default false, max 2 levels)'),
    }),
    execute: async (params) => {
      try {
        const dirPath = resolve((params.path as string) || '.');
        const recursive = params.recursive as boolean;

        if (recursive) {
          const entries = await globFn('**/*', {
            cwd: dirPath,
            ignore: ['node_modules/**', '.git/**', 'dist/**'],
            mark: true,
            maxDepth: 2,
          });
          return ok(entries.sort().join('\n') || '(empty directory)');
        }

        const entries = await readdir(dirPath, { withFileTypes: true });
        const lines = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(e => e.isDirectory() ? `${e.name}/` : e.name);
        return ok(lines.join('\n') || '(empty directory)');
      } catch (err) {
        return fail(`Cannot list directory: ${(err as Error).message}`);
      }
    },
  };
}

/**
 * Forget tracker entries for any tracked file referenced by the given shell
 * command. Matches by basename (foo.ts) or by relative/absolute path. Avoids
 * O(N) regex per path with a quick substring pre-filter.
 */
function forgetReferencedPaths(tracker: FileTracker, command: string, cwd: string): void {
  const tracked = tracker.paths();
  if (tracked.length === 0) return;
  for (const abs of tracked) {
    const rel = relative(cwd, abs);
    const base = abs.split('/').pop() ?? abs;
    if (command.includes(abs) || (rel && !rel.startsWith('..') && command.includes(rel)) || command.includes(base)) {
      tracker.forget(abs);
    }
  }
}

function createUpdateMemoryTool(): ToolDef {
  return {
    name: 'update_memory',
    description: 'Store an important fact, decision, or context in the conversation knowledge state. Use this when you learn something important that should persist across the conversation. Keys: fact, decision, question, project, current_task, or any custom key.',
    schema: z.object({
      key: z.string().describe('Category: fact, decision, question, project, current_task, or custom key'),
      value: z.string().describe('The information to remember'),
    }),
    execute: async (params) => {
      // Actual storage is handled by the agent (intercepted before reaching here)
      return ok(`Stored: ${params.key} = ${params.value}`);
    },
  };
}
