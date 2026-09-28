/**
 * `repo_map` — the repo's files with their top-level symbols, in one call.
 *
 * The system prompt already carries a file tree (names only). Finding where a
 * function lives still meant several glob/grep rounds, and every round is
 * context a small model does not have. This returns, per file, the functions,
 * classes, types and exports it defines, within a character budget.
 *
 * Symbols come from per-language patterns, not a parser: fast, no
 * dependency, and right for the declarations that matter for orientation
 * (top-level, exported). Files come from `git ls-files` so ignored files stay
 * out, and the ignore manager's protected patterns (.env, keys) are honoured.
 */
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative, resolve } from 'path';
import { z } from 'zod';
import type { ToolDef } from './types.js';
import { ok, fail } from './types.js';
import type { IgnoreManager } from '../ignore.js';

const BUDGET = 12_000;
const MAX_SYMBOLS_PER_FILE = 20;
const MAX_FILE_BYTES = 400_000;

const TS = [
  /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
];
const PATTERNS: Record<string, RegExp[]> = {
  '.ts': TS, '.tsx': TS, '.js': TS, '.jsx': TS, '.mjs': TS, '.cjs': TS, '.mts': TS,
  '.py': [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^class\s+([A-Za-z_]\w*)/],
  '.go': [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/],
  '.rs': [/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/],
  '.java': [/^(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+|static\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/],
  '.kt': [/^(?:public\s+|internal\s+|private\s+)?(?:data\s+|sealed\s+|abstract\s+|open\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/, /^(?:public\s+|internal\s+|private\s+)?fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/],
  '.cs': [/^\s{0,4}(?:public\s+|internal\s+)?(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/],
  '.rb': [/^\s{0,2}(?:def|class|module)\s+([A-Za-z_][\w.?!]*)/],
  '.sh': [/^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/],
};

/** Top-level declarations in one file's text. */
export function extractSymbols(ext: string, text: string): string[] {
  const pats = PATTERNS[ext];
  if (!pats) return [];
  const out: string[] = [];
  for (const line of text.split('\n')) {
    for (const re of pats) {
      const m = re.exec(line);
      if (m && m[1] && !out.includes(m[1])) { out.push(m[1]); break; }
    }
  }
  return out;
}

function listFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch {
    // Not a git repo: walk, skipping the usual heavy directories.
    const files: string[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv']);
    const walk = (dir: string, depth: number) => {
      if (depth > 8 || files.length > 5000) return;
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries) {
        if (skip.has(e) || e.startsWith('.')) continue;
        const p = join(dir, e);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p, depth + 1); else files.push(relative(root, p));
      }
    };
    walk(root, 0);
    return files;
  }
}

export function buildRepoMapTool(ignore?: IgnoreManager): ToolDef {
  return {
    name: 'repo_map',
    description: 'Map the repository: each source file with the functions, classes, types and exports it defines. Use it first to find where things live instead of several glob/grep rounds. Optionally limit to a subdirectory.',
    schema: z.object({
      path: z.string().optional().describe('Subdirectory to map (default: the whole repo)'),
    }),
    source: 'local',
    timeoutMs: 30_000,
    execute: async (params) => {
      const root = process.cwd();
      const sub = params.path ? resolve(root, String(params.path)) : root;
      if (!existsSync(sub)) return fail(`No such directory: ${params.path}`);
      const prefix = relative(root, sub);
      const files = listFiles(root)
        .filter(f => !prefix || f === prefix || f.startsWith(prefix + '/'))
        .filter(f => PATTERNS[extname(f)])
        .filter(f => !ignore || ignore.getBlockedReason(resolve(root, f)) === null)
        .sort();
      if (files.length === 0) return ok('No source files found here.');
      const lines: string[] = [];
      let used = 0;
      let shown = 0;
      for (const f of files) {
        let text: string;
        try {
          const abs = resolve(root, f);
          if (statSync(abs).size > MAX_FILE_BYTES) { text = ''; } else text = readFileSync(abs, 'utf-8');
        } catch { continue; }
        const syms = extractSymbols(extname(f), text);
        const more = syms.length > MAX_SYMBOLS_PER_FILE ? ` (+${syms.length - MAX_SYMBOLS_PER_FILE})` : '';
        const line = syms.length ? `${f}: ${syms.slice(0, MAX_SYMBOLS_PER_FILE).join(', ')}${more}` : f;
        if (used + line.length > BUDGET) break;
        lines.push(line);
        used += line.length + 1;
        shown++;
      }
      const tail = shown < files.length ? `\n[${files.length - shown} more files not shown — map a subdirectory with path]` : '';
      return ok(`${lines.join('\n')}${tail}`);
    },
  };
}
