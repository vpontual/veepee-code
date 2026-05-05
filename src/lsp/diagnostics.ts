/**
 * Format LSP diagnostics for agent consumption.
 *
 * The agent sees a tagged block in tool results; the format is borrowed
 * directly from charmbracelet/crush so it matches established patterns
 * in the LLM training data:
 *
 *   <file_diagnostics>
 *   Error: src/foo.ts:42:10 [typescript 2322] message
 *   Warn:  src/foo.ts:50:5  [typescript 6133] unused variable
 *   </file_diagnostics>
 *
 *   <project_diagnostics>
 *   Error: src/bar.ts:12:3 [typescript 2304] cannot find name 'foo'
 *   ... and 3 more diagnostics
 *   </project_diagnostics>
 *
 *   <diagnostic_summary>
 *   Current file: 1 error, 1 warning
 *   Project:      4 errors, 12 warnings
 *   </diagnostic_summary>
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { fileUriToPath } from './uri.js';
import { relative } from 'node:path';

const SECTION_CAP = 10;

/** A single labeled diagnostic source — the language label from config. */
export interface LabeledDiagnostic {
  /** Language label — "typescript", "go", etc. */
  source: string;
  /** Absolute file path (resolved from URI). */
  path: string;
  diagnostic: Diagnostic;
}

function severityWord(sev: DiagnosticSeverity | undefined): string {
  switch (sev) {
    case DiagnosticSeverity.Error: return 'Error';
    case DiagnosticSeverity.Warning: return 'Warn';
    case DiagnosticSeverity.Information: return 'Info';
    case DiagnosticSeverity.Hint: return 'Hint';
    default: return 'Note';
  }
}

function severityRank(sev: DiagnosticSeverity | undefined): number {
  // Lower rank sorts first. Errors before Warnings before Info before Hint.
  switch (sev) {
    case DiagnosticSeverity.Error: return 0;
    case DiagnosticSeverity.Warning: return 1;
    case DiagnosticSeverity.Information: return 2;
    case DiagnosticSeverity.Hint: return 3;
    default: return 4;
  }
}

/** Format a single diagnostic as one line. Path is rendered relative to cwd. */
export function formatDiagnostic(d: LabeledDiagnostic, cwd: string = process.cwd()): string {
  const sev = severityWord(d.diagnostic.severity);
  const rel = relative(cwd, d.path) || d.path;
  // LSP positions are 0-indexed; humans expect 1-indexed lines and 1-indexed columns
  const line = d.diagnostic.range.start.line + 1;
  const col = d.diagnostic.range.start.character + 1;
  // Code may be missing (gopls), a string (typescript), or a number.
  const codeRaw = d.diagnostic.code;
  const codeStr = codeRaw === undefined || codeRaw === null || codeRaw === ''
    ? `[${d.source}]`
    : `[${d.source} ${String(codeRaw)}]`;
  // Some servers include trailing newlines; trim once.
  const msg = (d.diagnostic.message || '').trim();
  return `${sev}: ${rel}:${line}:${col} ${codeStr} ${msg}`;
}

interface Counts {
  errors: number;
  warnings: number;
  info: number;
  hint: number;
}

function emptyCounts(): Counts {
  return { errors: 0, warnings: 0, info: 0, hint: 0 };
}

function tally(diags: LabeledDiagnostic[]): Counts {
  const c = emptyCounts();
  for (const d of diags) {
    switch (d.diagnostic.severity) {
      case DiagnosticSeverity.Error: c.errors++; break;
      case DiagnosticSeverity.Warning: c.warnings++; break;
      case DiagnosticSeverity.Information: c.info++; break;
      case DiagnosticSeverity.Hint: c.hint++; break;
      default: break;
    }
  }
  return c;
}

function pluralize(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

function summaryLine(label: string, c: Counts, padTo: number): string {
  const parts: string[] = [];
  if (c.errors) parts.push(pluralize(c.errors, 'error'));
  if (c.warnings) parts.push(pluralize(c.warnings, 'warning'));
  if (c.info) parts.push(pluralize(c.info, 'info'));
  if (c.hint) parts.push(pluralize(c.hint, 'hint'));
  if (parts.length === 0) parts.push('clean');
  return `${(label + ':').padEnd(padTo)} ${parts.join(', ')}`;
}

function sortDiagnostics(diags: LabeledDiagnostic[]): LabeledDiagnostic[] {
  return [...diags].sort((a, b) => {
    const sa = severityRank(a.diagnostic.severity);
    const sb = severityRank(b.diagnostic.severity);
    if (sa !== sb) return sa - sb;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.diagnostic.range.start.line - b.diagnostic.range.start.line;
  });
}

function renderSection(title: string, diags: LabeledDiagnostic[], cwd: string): string {
  if (diags.length === 0) return '';
  const sorted = sortDiagnostics(diags);
  const shown = sorted.slice(0, SECTION_CAP).map((d) => formatDiagnostic(d, cwd));
  if (sorted.length > SECTION_CAP) {
    shown.push(`... and ${sorted.length - SECTION_CAP} more diagnostic${sorted.length - SECTION_CAP === 1 ? '' : 's'}`);
  }
  return `<${title}>\n${shown.join('\n')}\n</${title}>`;
}

/**
 * Render the full three-section diagnostics block.
 *
 * @param byUri  per-URI diagnostics from across all running clients. URIs
 *               are file:// strings; we resolve to absolute paths via the
 *               LabeledDiagnostic.path field.
 * @param currentFile  absolute path of the file the agent just edited, or
 *               undefined for a project-wide query. When provided, the
 *               file's diagnostics go to <file_diagnostics> and the rest
 *               to <project_diagnostics>.
 * @param cwd    used to render paths relative to the user's project root.
 *
 * Returns the empty string if there are no diagnostics anywhere — callers
 * should detect this and skip emitting the block to avoid noise.
 */
export function formatDiagnostics(
  byUri: Map<string, { source: string; diagnostics: Diagnostic[] }>,
  currentFile?: string,
  cwd: string = process.cwd(),
): string {
  // Flatten + label
  const all: LabeledDiagnostic[] = [];
  for (const [uri, entry] of byUri) {
    let p: string;
    try { p = fileUriToPath(uri); } catch { continue; }
    for (const d of entry.diagnostics) {
      all.push({ source: entry.source, path: p, diagnostic: d });
    }
  }
  if (all.length === 0) return '';

  let fileDiags: LabeledDiagnostic[] = [];
  let otherDiags: LabeledDiagnostic[] = [];
  if (currentFile) {
    for (const d of all) {
      if (d.path === currentFile) fileDiags.push(d);
      else otherDiags.push(d);
    }
  } else {
    // No current file → everything is "project"
    otherDiags = all;
  }

  const fileSection = renderSection('file_diagnostics', fileDiags, cwd);
  const projectSection = renderSection('project_diagnostics', otherDiags, cwd);

  // Build summary
  const lines: string[] = [];
  if (fileSection) lines.push(fileSection);
  if (projectSection) lines.push(projectSection);

  if (currentFile) {
    const fileC = tally(fileDiags);
    const projC = tally(otherDiags);
    const summary = [
      summaryLine('Current file', fileC, 14),
      summaryLine('Project',      projC, 14),
    ].join('\n');
    lines.push(`<diagnostic_summary>\n${summary}\n</diagnostic_summary>`);
  } else {
    const c = tally(all);
    lines.push(`<diagnostic_summary>\n${summaryLine('Project', c, 0)}\n</diagnostic_summary>`);
  }

  return lines.join('\n\n');
}
