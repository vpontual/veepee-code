/**
 * Skills system — lazy-loaded markdown knowledge units.
 *
 * Skills are markdown files with YAML frontmatter (name, description,
 * tags?, model?, allowed-tools?). Loaded from `~/.veepee-code/skills/`
 * (global) and `<cwd>/.veepee/skills/` (project, shadows global by name).
 *
 * Two layouts are accepted: a flat `<name>.md`, and a `<name>/SKILL.md`
 * bundle whose directory may hold companion markdown the body links to. The
 * bundle is the ecosystem convention — Claude Code, Codex, Pi and Omarchy all
 * use it, and Omarchy symlinks each `default/agents/skills` bundle into every agent's
 * skills directory — so supporting it is what lets vcode consume skills it
 * did not write.
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
import { parseFrontmatter } from './frontmatter.js';

/** The ecosystem's filename for the entry point of a skill bundle. */
const SKILL_FILE = 'SKILL.md';

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
  /** Directory holding the skill, for the bundle layout (`<name>/SKILL.md`).
   *  Undefined for a bare `<name>.md`. */
  bundleDir?: string;
  /** Absolute paths of the other markdown files sitting beside SKILL.md.
   *  Bundled skills reference these by bare relative name ("see hyprland.md"),
   *  which the model cannot resolve from the body alone — so skill_invoke
   *  lists them. */
  companions?: string[];
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

/** The other `.md` files beside a bundle's SKILL.md, as absolute paths. */
function companionsOf(bundleDir: string): string[] {
  try {
    return readdirSync(bundleDir)
      .filter((f) => f.endsWith('.md') && f !== SKILL_FILE)
      .sort()
      .map((f) => resolve(bundleDir, f));
  } catch {
    return [];
  }
}

function loadFromDir(dir: string, source: 'global' | 'project'): Skill[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  // Bare files first, bundles second, each alphabetically: readdir order is
  // filesystem-dependent, and a bundle is the richer of two same-named skills,
  // so it should be the one that wins.
  const bare = entries.filter((e) => e.endsWith('.md')).sort();
  const bundles = entries.filter((e) => !e.endsWith('.md')).sort();
  const out: Skill[] = [];
  for (const entry of [...bare, ...bundles]) {
    // Two layouts. `<name>.md` is vcode's original flat skill. `<name>/SKILL.md`
    // is what the rest of the ecosystem ships — Claude Code, Codex, Pi and
    // Omarchy's `default/agents/skills/` all use it, and Omarchy symlinks its
    // skills into each agent's directory. Reading only flat files meant those
    // bundles were skipped in silence: a directory entry simply isn't a `.md`.
    const bundleDir = entry.endsWith('.md') ? undefined : resolve(dir, entry);
    const path = bundleDir ? resolve(bundleDir, SKILL_FILE) : resolve(dir, entry);
    // Covers both "not a directory" and "a directory with no SKILL.md".
    if (bundleDir && !existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const fallbackName = bundleDir ? entry : entry.replace(/\.md$/, '');
    const name = (meta.name || fallbackName).trim();
    if (!name) continue;
    out.push({
      name,
      description: meta.description || `(no description in ${entry})`,
      tags: parseList(meta.tags),
      model: meta.model,
      allowedTools: parseList(meta['allowed-tools']),
      requiresTools: parseList(meta['requires-tools']),
      fallbackForTools: parseList(meta['fallback-for-tools']),
      content: body.trim(),
      source,
      path,
      bundleDir,
      companions: bundleDir ? companionsOf(bundleDir) : undefined,
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

  // The index rides in this tool description on EVERY request, so it is a
  // per-turn tax, not a one-off. The old comment budgeted "~50-80 chars" per
  // line; measured against the ecosystem `SKILL.md` bundles this repo now reads,
  // the real figure is ~531 — descriptions there carry whole trigger lists.
  // Nothing pruned, and `teacher-escalation` WRITES new skills into the same
  // directory automatically, so the tax grew monotonically and silently.
  //
  // Two caps, both deliberate. Per line: enough to route to the right skill,
  // which is all the index has to do — the body arrives when it is invoked.
  // Overall: a hard ceiling, with the remainder named but not described, because
  // a name is still routable and an unbounded index is not.
  const SKILL_LINE_MAX = 180;
  const SKILL_INDEX_MAX = 8_000;

  const line = (s: Skill): string => {
    const tagsHint = s.tags && s.tags.length > 0 ? ` [${s.tags.join(',')}]` : '';
    const head = `  • ${s.name}${tagsHint} — `;
    const room = Math.max(40, SKILL_LINE_MAX - head.length);
    const desc = s.description.replace(/\s+/g, ' ').trim();
    return head + (desc.length > room ? desc.slice(0, room - 1).trimEnd() + '…' : desc);
  };

  const indexLines: string[] = [];
  const overflow: string[] = [];
  let used = 0;
  for (const s of skills) {
    const l = line(s);
    if (used + l.length > SKILL_INDEX_MAX) { overflow.push(s.name); continue; }
    indexLines.push(l);
    used += l.length;
  }
  if (overflow.length > 0) {
    indexLines.push(`  • (also available, by name only: ${overflow.join(', ')})`);
  }

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
      // A bundled skill's body links to its companions by bare relative name
      // ("see hyprland.md"). The model has no idea where that resolves to, so
      // hand it absolute paths rather than let it guess or give up.
      if (match.companions && match.companions.length > 0) {
        lines.push('Companion files for this skill (read them when the body refers to them):');
        for (const file of match.companions) lines.push(`  ${file}`);
        lines.push('');
      }
      lines.push(match.content);
      return { success: true, output: lines.join('\n') };
    },
  };
}
