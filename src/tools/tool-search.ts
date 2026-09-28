/**
 * `tool_search` — load tools from connected tool servers on demand.
 *
 * Every offered tool's schema is sent on every request. A few MCP servers add
 * dozens of tools (Palomino alone has ~21), which crowds a 16k-context Ollama
 * model and dilutes tool choice for any model. Past a threshold, MCP tools are
 * registered deferred: the model sees one line per server here, searches, and
 * the matching tools are offered from its next step on.
 */
import { z } from 'zod';
import type { ToolDef } from './types.js';
import { ok, fail } from './types.js';
import type { ToolRegistry } from './registry.js';

const MAX_LOAD = 6;

export function buildToolSearchTool(registry: ToolRegistry): ToolDef {
  const bySource = new Map<string, number>();
  for (const t of registry.deferredTools()) bySource.set(t.sourceName ?? 'other', (bySource.get(t.sourceName ?? 'other') ?? 0) + 1);
  const summary = [...bySource].map(([s, n]) => `${s} (${n} tools)`).join(', ');
  return {
    name: 'tool_search',
    description:
      `Find and load tools from connected tool servers that are not loaded yet: ${summary}. ` +
      'Search by what you want to do (e.g. "calendar events", "send telegram"), or load exact tools with "select:name1,name2". ' +
      'Matching tools become available from your next step.',
    schema: z.object({
      query: z.string().describe('Keywords for what you need, or "select:<tool>,<tool>"'),
    }),
    source: 'local',
    timeoutMs: 5_000,
    execute: async (params) => {
      const query = String(params.query ?? '').trim();
      const pool = registry.deferredTools();
      if (pool.length === 0) return ok('Every tool is already loaded.');
      let picked;
      if (query.startsWith('select:')) {
        const want = new Set(query.slice(7).split(',').map(s => s.trim()).filter(Boolean));
        picked = pool.filter(t => want.has(t.name) || want.has(t.name.replace(/^mcp__[^_]+__/, '')));
      } else {
        const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
        picked = pool
          .map(t => {
            const hay = `${t.name} ${t.description}`.toLowerCase();
            return { t, score: words.reduce((n, w) => n + (hay.includes(w) ? (t.name.toLowerCase().includes(w) ? 3 : 1) : 0), 0) };
          })
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_LOAD)
          .map(x => x.t);
      }
      if (picked.length === 0) {
        return fail(`No unloaded tool matches "${query}". Unloaded: ${pool.map(t => t.name).join(', ')}`);
      }
      registry.activate(picked.map(t => t.name));
      return ok(`Loaded — available from your next step:\n${picked.map(t => `- ${t.name}: ${t.description.slice(0, 200)}`).join('\n')}`);
    },
  };
}
