import { readFile, writeFile, stat, readdir } from 'fs/promises';
import { resolve, relative, join } from 'path';
import { existsSync } from 'fs';
import { execSync, execFileSync, spawn } from 'child_process';
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
    if (!label) return '';
    await notifyLSPs(lspManager, filePath);
    const block = formatDiagnostics(lspManager.getAllDiagnostics(), filePath);
    const failure = lspManager.failureReason(label);
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
        const limit = (params.limit as number) || lines.length;
        const slice = lines.slice(offset, offset + limit);

        const numbered = slice
          .map((line, i) => `${String(offset + i + 1).padStart(5)}  ${line}`)
          .join('\n');

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
  /** Add this to the needle's indentation to get the file's. */
  indentDelta: string;
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
    let delta: string | null = null;
    let uniform = true;
    for (let j = 0; j < needle.length; j++) {
      if (needle[j].trim() === '') continue;
      const fileIndent = indentOf(lines[i + j]);
      const needleIndent = indentOf(needle[j]);
      // Only ADDING indentation is safe; if the file is less indented than the
      // needle, re-indenting could dedent past column 0.
      if (!fileIndent.startsWith(needleIndent)) { uniform = false; break; }
      const d = fileIndent.slice(needleIndent.length);
      if (delta === null) delta = d;
      else if (d !== delta) { uniform = false; break; }
    }
    if (!uniform || delta === null) continue;
    out.push({ startLine: i, endLine: i + needle.length - 1, indentDelta: delta });
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
export function uniformIndentDelta(matched: string, needle: string): string {
  const a = matched.split('\n');
  const b = needle.split('\n');
  while (b.length > 1 && b[b.length - 1].trim() === '') b.pop();
  if (a.length !== b.length) return '';
  let delta: string | null = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i].trim() === '' || b[i].trim() === '') continue;
    const ai = indentOf(a[i]);
    const bi = indentOf(b[i]);
    if (!ai.startsWith(bi)) return '';
    const d = ai.slice(bi.length);
    if (delta === null) delta = d;
    else if (d !== delta) return '';
  }
  return delta ?? '';
}

/** Re-indent every non-blank line of a replacement by `delta`. */
export function reindent(text: string, delta: string): string {
  if (!delta) return text;
  return text.split('\n').map((l) => (l.trim() === '' ? l : delta + l)).join('\n');
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
  const hint = lineIdx >= 0
    ? `\nNearest match around line ${lineIdx + 1}:\n${lines
        .slice(Math.max(0, lineIdx - 1), lineIdx + 3)
        .map((l, i) => `  ${Math.max(1, lineIdx) + i}: ${l}`)
        .join('\n')}`
    : '';
  return `${base} Read the file first to get the exact content.${hint}`;
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
      const { startLine, endLine, indentDelta } = indentMatches[0];
      const lines = content.split('\n');
      const replacement = reindent(newStr, indentDelta);
      const updated = [...lines.slice(0, startLine), ...replacement.split('\n'), ...lines.slice(endLine + 1)].join('\n');
      return { ok: true, updated, matchCount: 1 };
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
    const delta = atLineStart
      ? uniformIndentDelta(prefix + content.slice(start, end), oldStr)
      : '';
    updated = updated.slice(0, start) + (delta ? reindent(newStr, delta) : newStr) + updated.slice(end);
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
      edits: z.array(z.object({
        old_string: z.string().describe('Exact string to find and replace'),
        new_string: z.string().describe('Replacement string'),
        replace_all: z.boolean().optional().default(false).describe('Replace all occurrences instead of requiring uniqueness'),
      })).min(1).describe('List of edits to apply in order against the running content'),
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

        let stdout = '';
        let stderr = '';
        const MAX_OUTPUT = 512 * 1024; // 512KB cap per stream
        let truncated = false;

        child.stdout.on('data', (data: Buffer) => {
          if (stdout.length < MAX_OUTPUT) {
            stdout += data.toString();
          } else if (!truncated) {
            truncated = true;
            stdout += '\n...(output truncated at 512KB)';
          }
        });
        child.stderr.on('data', (data: Buffer) => {
          if (stderr.length < MAX_OUTPUT) {
            stderr += data.toString();
          }
        });

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
          clearTimeout(hardTimer);
          if (graceTimer) clearTimeout(graceTimer);
          // Stop holding the pipes so node isn't kept alive by a survivor.
          child.stdout.destroy();
          child.stderr.destroy();
          res(result);
        };
        const compose = () => stdout + (stderr ? `\n[stderr]\n${stderr}` : '');

        // Kill the whole process group. Negative pid = the group led by `child`.
        const killTree = (signal: NodeJS.Signals) => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, signal);
          } catch {
            // Group already gone, or we lost the race — nothing to reap.
          }
        };

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
        child.on('exit', () => {
          if (settled || graceTimer) return;
          graceTimer = setTimeout(() => {
            const out = compose().trim();
            finish(ok(
              (out ? out + '\n' : '') +
              '(note: the command exited but left a background process holding its output stream; ' +
              'it is still running and detached from this tool call)',
            ));
          }, OUTPUT_FLUSH_GRACE_MS);
        });

        child.on('close', (code) => {
          const output = compose();
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
