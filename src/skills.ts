/**
 * Skills system — lazy-loaded markdown knowledge units.
 *
 * Skills are markdown files with YAML frontmatter (name, description,
 * tags?, model?, allowed-tools?). Loaded from `~/.veepee-code/skills/`
 * (global) and `<cwd>/.veepee/skills/` (project, shadows global by name).
 *
 * The crucial design decision: skills are NOT in the system prompt. Only a
 * compact INDEX (just names + descriptions, ~50 tokens per skill) is in
 * the description of the `skill_invoke` meta-tool. When the model decides
 * a skill is relevant, it calls `skill_invoke({name: 'foo'})` and the full
 * skill content is returned as the tool result — landing in the model's
 * context only at the moment it's needed.
 *
 * This is the same pattern that took Llama Rider's system prompt from
 * ~20k tokens → ~3k after the 2026-04-23 audit. For vcode it means we can
 * ship dozens of skills without bloating the per-turn token cost (only the
 * index lives in every prompt; the bodies live on disk).
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { getConfigDir, getProjectSettingsDir } from './config.js';
import type { ToolDef, ToolResult } from './tools/types.js';

export interface Skill {
  name: string;
  description: string;
  tags?: string[];
  /** Optional model recommendation. Advisory only — vcode doesn't switch
   *  models on skill invoke (would surprise users mid-task). The model can
   *  see this in the tool result and act accordingly. */
  model?: string;
  /** Tools the skill is designed to use. Surfaced in the tool result so
   *  the model knows what's relevant. Not enforced as a hard restriction
   *  in this iteration — Phase 3 may revisit when subagents land. */
  allowedTools?: string[];
  /** Markdown body (frontmatter stripped, trimmed). */
  content: string;
  source: 'global' | 'project';
  path: string;
  /** Toolset-conditional gating (frontmatter `requires-tools` /
   *  `fallback-for-tools`). `requiresTools`: hide from the index unless ALL of
   *  these tools are registered on this node. `fallbackForTools`: hide when ANY
   *  is registered (a fallback skill that yields to a better native tool). Lets
   *  a skill that says "use the browser MCP" not surface on a node without it,
   *  and a curl-fallback disappear where the native tool exists. */
  requiresTools?: string[];
  fallbackForTools?: string[];
}

// ─── Frontmatter parser ────────────────────────────────────────────────
//
// Matches user-commands.ts shape. Skills add list-valued fields (tags,
// allowed-tools) for which we accept either YAML inline `[a, b]` or
// comma-separated bare strings. Keeps users out of YAML-quoting hell.

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

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  // YAML inline: [a, b, c]
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  // Comma-separated bare
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

// ─── Discovery ─────────────────────────────────────────────────────────

function getGlobalSkillsDir(): string {
  return resolve(getConfigDir(), 'skills');
}

function getProjectSkillsDir(cwd: string = process.cwd()): string {
  return resolve(getProjectSettingsDir(cwd), 'skills');
}

function loadFromDir(dir: string, source: 'global' | 'project'): Skill[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
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
    const name = (meta.name || file.replace(/\.md$/, '')).trim();
    if (!name) continue;
    out.push({
      name,
      description: meta.description || `(no description in ${file})`,
      tags: parseList(meta.tags),
      model: meta.model,
      allowedTools: parseList(meta['allowed-tools']),
      requiresTools: parseList(meta['requires-tools']),
      fallbackForTools: parseList(meta['fallback-for-tools']),
      content: body.trim(),
      source,
      path,
    });
  }
  return out;
}

/** Discover all skills. Project shadows global by name. Sorted alphabetically. */
export function loadSkills(cwd: string = process.cwd()): Skill[] {
  const global = loadFromDir(getGlobalSkillsDir(), 'global');
  const project = loadFromDir(getProjectSkillsDir(cwd), 'project');
  const byName = new Map<string, Skill>();
  for (const s of global) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── skill_invoke tool ─────────────────────────────────────────────────
//
// Returns a single ToolDef when there's at least one skill on disk.
// Description embeds the index; execute looks up the requested skill and
// returns its body. The model MUST call this — content is never auto-
// loaded into the system prompt. That's the whole point: cheap menu, paid
// content only when used.

export function buildSkillInvokeTool(cwd: string = process.cwd(), activeTools: string[] = []): ToolDef | null {
  const active = new Set(activeTools);
  // Toolset-conditional gating: a skill needing tools this node lacks, or a
  // fallback superseded by an available native tool, is kept out of the index.
  const skills = loadSkills(cwd).filter((s) => {
    if (s.requiresTools && s.requiresTools.some((t) => !active.has(t))) return false;
    if (s.fallbackForTools && s.fallbackForTools.some((t) => active.has(t))) return false;
    return true;
  });
  if (skills.length === 0) return null;

  // Index fits in the tool description. Each line is short (~50-80 chars).
  // For ~50 skills that's ~3k chars / ~750 tokens — well within budget.
  const indexLines = skills.map((s) => {
    const tagsHint = s.tags && s.tags.length > 0 ? ` [${s.tags.join(',')}]` : '';
    return `  • ${s.name}${tagsHint} — ${s.description}`;
  });

  const description = [
    'Load a skill on demand. Skills are pre-written guidance for specific tasks (e.g., "create-pull-request", "write-test", "refactor-component").',
    'Call this when the task matches one of the skills below; the skill body will be returned as the tool result, and you should follow it for the rest of the turn.',
    '',
    'Available skills:',
    ...indexLines,
  ].join('\n');

  return {
    name: 'skill_invoke',
    description,
    schema: z.object({
      name: z.string().describe('The exact name of the skill to invoke (case-sensitive, from the index above).'),
    }),
    source: 'skill',
    sourceName: 'index',
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      const requested = String(params.name ?? '').trim();
      // Re-load on each call so dropping a new file in skills/ takes effect
      // without a vcode restart. Cheap (≤ a few dozen file reads) and
      // matches how user slash commands behave.
      const fresh = loadSkills(cwd);
      const match = fresh.find((s) => s.name === requested);
      if (!match) {
        return {
          success: false,
          output: '',
          error: `Skill not found: '${requested}'. Available: ${fresh.map((s) => s.name).join(', ') || '(none)'}`,
        };
      }

      // Body of the skill, plus advisory metadata. Tool restrictions in
      // the frontmatter are surfaced as a hint — Phase 3 may enforce them
      // when subagents land, but for now the model honors descriptions.
      const lines: string[] = [];
      lines.push(`# Skill: ${match.name}`);
      if (match.description) lines.push(`> ${match.description}`);
      lines.push('');
      if (match.allowedTools && match.allowedTools.length > 0) {
        lines.push(`Recommended tools while working on this: ${match.allowedTools.join(', ')}`);
        lines.push('');
      }
      if (match.model) {
        lines.push(`(Skill author recommends model: ${match.model})`);
        lines.push('');
      }
      lines.push(match.content);
      return { success: true, output: lines.join('\n') };
    },
  };
}
