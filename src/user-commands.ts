/**
 * User-defined slash commands.
 *
 * Markdown files in `~/.veepee-code/commands/` (global) and
 * `<cwd>/.veepee/commands/` (project) are exposed as `/<filename>` commands.
 * Frontmatter declares metadata; the body is the prompt template.
 *
 * Example file `~/.veepee-code/commands/review.md`:
 *
 *   ---
 *   description: Review the current PR
 *   argument-hint: [pr-number]
 *   ---
 *
 *   Please review PR #$1 for code quality, security, and tests.
 *
 * Invoked as `/review 123` — the body becomes the user prompt with `$1`
 * substituted to "123". Project commands shadow global commands by name.
 *
 * Mirrors Claude Code's `~/.claude/commands/` layout for muscle-memory
 * portability.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getConfigDir, getProjectSettingsDir } from './config.js';

export interface UserCommand {
  /** Slash command name without leading `/`. Derived from filename (.md stripped). */
  name: string;
  /** One-line description shown in /help and command palette. */
  description: string;
  /** Optional usage hint for arguments, e.g. "[file] [option]". */
  argumentHint?: string;
  /** Prompt template (body of the markdown file, frontmatter stripped). */
  template: string;
  /** Where the command was loaded from — used for /commands listing and conflict resolution. */
  source: 'global' | 'project';
  /** Absolute path to the source file, for editor hints and debugging. */
  path: string;
}

// ─── Frontmatter parser ────────────────────────────────────────────────
//
// Minimal YAML-style frontmatter — only `key: value` lines are supported, no
// nested structures. That matches every real-world slash command we'd want
// to author and avoids dragging in a YAML dep for one file format.

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
    // Strip simple surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body };
}

// ─── Discovery ─────────────────────────────────────────────────────────

function getGlobalCommandsDir(): string {
  return resolve(getConfigDir(), 'commands');
}

function getProjectCommandsDir(cwd: string = process.cwd()): string {
  return resolve(getProjectSettingsDir(cwd), 'commands');
}

function loadFromDir(dir: string, source: 'global' | 'project'): UserCommand[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: UserCommand[] = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const path = resolve(dir, file);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const name = file.replace(/\.md$/, '');
    out.push({
      name,
      description: meta.description || `(no description in ${file})`,
      argumentHint: meta['argument-hint'],
      template: body.trim(),
      source,
      path,
    });
  }
  return out;
}

/** Discover all user commands. Project commands shadow global ones by name. */
export function loadUserCommands(cwd: string = process.cwd()): UserCommand[] {
  const global = loadFromDir(getGlobalCommandsDir(), 'global');
  const project = loadFromDir(getProjectCommandsDir(cwd), 'project');
  // Project shadows global on name conflict.
  const byName = new Map<string, UserCommand>();
  for (const c of global) byName.set(c.name, c);
  for (const c of project) byName.set(c.name, c);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Find a command by name. Returns undefined when not found. */
export function findUserCommand(name: string, cwd: string = process.cwd()): UserCommand | undefined {
  return loadUserCommands(cwd).find((c) => c.name === name);
}

// ─── Expansion ─────────────────────────────────────────────────────────
//
// Body text gets `$1`, `$2`, ..., `$9` substituted with positional args, and
// `$ARGUMENTS` (or `$@`) with the full arg string. Bash-style `${var}` is
// also accepted for positional args. Unknown tokens are left as-is so
// authors can include literal `$` in templates without escaping.

export function expandCommand(cmd: UserCommand, argString: string): string {
  const args = argString.trim().length > 0 ? argString.trim().split(/\s+/) : [];
  let out = cmd.template;
  out = out.replace(/\$ARGUMENTS\b|\$@/g, argString.trim());
  out = out.replace(/\$\{?(\d)\}?/g, (_m, n) => args[parseInt(n, 10) - 1] ?? '');
  return out;
}
