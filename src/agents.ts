/**
 * Named subagents: reusable roles defined in markdown files.
 *
 * A file gives a role a name, a description, a tool allowlist, optionally a
 * model, and its instructions (the body). The `task` tool takes `agent: name`
 * instead of the parent spelling all of that out on every call — which is also
 * how fleet routing becomes a role ("reviewer runs on gemma") rather than a
 * model name the parent has to remember.
 *
 * The format is Claude Code's, on purpose, and so are the folders: an agent
 * written for Claude Code in ~/.claude/agents works here unchanged. Searched in
 * order, first name wins:
 *   <project>/.veepee/agents/*.md   project roles
 *   ~/.veepee-code/agents/*.md      vcode-only roles
 *   ~/.claude/agents/*.md           roles shared with Claude Code
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import os from 'os';
import { parseFrontmatter } from './frontmatter.js';

export interface AgentDefinition {
  name: string;
  description: string;
  /** vcode tool names; undefined = the subagent default (read-only + web). */
  tools?: string[];
  /** A fleet model name; undefined = the default subagent model. */
  model?: string;
  instructions: string;
  source: string;
}

/** Claude Code tool names → vcode's. Lower-case vcode names pass through. */
const TOOL_NAMES: Record<string, string> = {
  Read: 'read_file', Write: 'write_file', Edit: 'edit_file', MultiEdit: 'multi_edit',
  Bash: 'bash', Grep: 'grep', Glob: 'glob', LS: 'list_files', WebFetch: 'web_fetch',
  WebSearch: 'web_search', NotebookEdit: 'notebook_edit', TodoWrite: 'todo_write',
  BashOutput: 'bash_output', KillShell: 'kill_shell',
};

/** Model values that name a Claude model, not one of ours. */
const CLAUDE_MODEL = /^(inherit|sonnet|opus|haiku|fable)$|^claude/i;

function parseTools(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  if (/^\[\s*\]$/.test(value.trim())) return []; // explicitly no tools
  const raw = value.trim().replace(/^\[|\]$/g, '');
  const names = raw.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const mapped = names
    .map(n => TOOL_NAMES[n] ?? (/^[a-z_]+$/.test(n) ? n : undefined))
    .filter((n): n is string => !!n);
  return mapped.length > 0 ? [...new Set(mapped)] : undefined;
}

export function agentDirs(cwd: string = process.cwd()): string[] {
  return [
    resolve(cwd, '.veepee', 'agents'),
    join(os.homedir(), '.veepee-code', 'agents'),
    join(os.homedir(), '.claude', 'agents'),
  ];
}

export function loadAgentDefinitions(cwd: string = process.cwd()): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const dir of agentDirs(cwd)) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir).filter(f => f.endsWith('.md')).sort(); } catch { continue; }
    for (const f of files) {
      const path = join(dir, f);
      let parsed;
      try { parsed = parseFrontmatter(readFileSync(path, 'utf-8')); } catch { continue; }
      const name = (parsed.meta.name || f.replace(/\.md$/, '')).trim();
      if (!name || byName.has(name)) continue;
      const model = parsed.meta.model?.trim();
      byName.set(name, {
        name,
        description: (parsed.meta.description || '').trim(),
        tools: parseTools(parsed.meta.tools),
        model: model && !CLAUDE_MODEL.test(model) ? model : undefined,
        instructions: parsed.body.trim(),
        source: path,
      });
    }
  }
  return [...byName.values()];
}
