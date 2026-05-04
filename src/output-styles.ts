/**
 * Output styles — persona/voice overlays for the system prompt.
 *
 * Three built-ins ship in-source (default/explanatory/learning) so the
 * feature works out of the box. Users can drop markdown files in
 * `~/.veepee-code/output-styles/<name>.md` (global) or
 * `.veepee/output-styles/<name>.md` (project, shadows global) to add
 * custom styles or override the built-ins.
 *
 * The active style is session-scoped — set via /output-style <name>, reset
 * on restart. Persistent default-style preference can be set by overriding
 * `default.md` (project or global). Mirrors Claude Code's Default /
 * Explanatory / Learning naming for muscle-memory portability.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getConfigDir, getProjectSettingsDir } from './config.js';

export interface OutputStyle {
  name: string;
  description: string;
  /** Content appended to the system prompt as a style overlay. */
  prompt: string;
  source: 'builtin' | 'global' | 'project';
}

// ─── Built-in styles ───────────────────────────────────────────────────

const BUILTINS: OutputStyle[] = [
  {
    name: 'default',
    description: 'Concise, action-first. Lead with the answer, no preamble.',
    source: 'builtin',
    prompt: '',  // The base system prompt is already concise; default = no overlay.
  },
  {
    name: 'explanatory',
    description: 'Show reasoning and explain non-obvious decisions.',
    source: 'builtin',
    prompt: [
      '## Output style: explanatory',
      '',
      'Show your reasoning when it helps the user understand WHY, not just what.',
      'For non-trivial decisions, briefly state the trade-off you considered and why you picked the option you did.',
      'Still favor signal over volume — explain the things that aren\'t obvious from the code itself, not the things a careful reader would already see.',
    ].join('\n'),
  },
  {
    name: 'learning',
    description: 'Teach as you go — include the underlying concept when relevant.',
    source: 'builtin',
    prompt: [
      '## Output style: learning',
      '',
      'Treat each task as an opportunity to teach. When you use a non-obvious technique, briefly explain the concept behind it.',
      'When fixing a bug, explain WHY the bug happened — not just the symptom.',
      'Cite documentation or canonical references when relevant. Use simple language and concrete examples.',
      'Still ship working code; learning content is alongside the work, not a substitute for it.',
    ].join('\n'),
  },
];

// ─── Frontmatter parser ────────────────────────────────────────────────

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!raw.startsWith('---')) return { meta, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta, body: raw };
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, '');
  for (const line of fm.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body };
}

// ─── Discovery ─────────────────────────────────────────────────────────

function getGlobalStylesDir(): string {
  return resolve(getConfigDir(), 'output-styles');
}

function getProjectStylesDir(cwd: string = process.cwd()): string {
  return resolve(getProjectSettingsDir(cwd), 'output-styles');
}

function loadFromDir(dir: string, source: 'global' | 'project'): OutputStyle[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: OutputStyle[] = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const path = resolve(dir, file);
    let raw: string;
    try { raw = readFileSync(path, 'utf-8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(raw);
    const name = (meta.name || file.replace(/\.md$/, '')).trim();
    if (!name) continue;
    out.push({
      name,
      description: meta.description || `(no description in ${file})`,
      prompt: body.trim(),
      source,
    });
  }
  return out;
}

/** All available styles. Project overrides global overrides built-in. */
export function loadOutputStyles(cwd: string = process.cwd()): OutputStyle[] {
  const byName = new Map<string, OutputStyle>();
  for (const s of BUILTINS) byName.set(s.name, s);
  for (const s of loadFromDir(getGlobalStylesDir(), 'global')) byName.set(s.name, s);
  for (const s of loadFromDir(getProjectStylesDir(cwd), 'project')) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Find a style by name. Returns the default style if name is unknown. */
export function findOutputStyle(name: string, cwd: string = process.cwd()): OutputStyle | undefined {
  return loadOutputStyles(cwd).find((s) => s.name === name);
}

/** Default style — what the agent uses when none is explicitly set. */
export function getDefaultStyle(): OutputStyle {
  return BUILTINS[0]!;
}

// ─── Active style state ────────────────────────────────────────────────
//
// Session-scoped — kept in a module-level variable for simplicity. /output-style
// command updates it; the agent reads it at system-prompt build time.

let activeStyleName: string = 'default';

export function getActiveStyleName(): string {
  return activeStyleName;
}

export function setActiveStyle(name: string): boolean {
  const style = findOutputStyle(name);
  if (!style) return false;
  activeStyleName = name;
  return true;
}

/** Returns the system-prompt overlay for the active style. Empty string
 *  for `default` (no overlay). Caller appends to the base system prompt. */
export function getActiveOverlay(cwd: string = process.cwd()): string {
  const style = findOutputStyle(activeStyleName, cwd) ?? getDefaultStyle();
  return style.prompt;
}

/** Backward-compat alias for context.ts (used existing styles.ts shape). */
export function getOutputStyle(name: string, cwd: string = process.cwd()): OutputStyle | undefined {
  return findOutputStyle(name, cwd);
}
