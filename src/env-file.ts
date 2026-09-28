/**
 * Reading and editing `~/.veepee-code/.env` — the file that holds vcode's
 * endpoints and secrets (see ENV_KEYS in config.ts for which settings).
 *
 * Edits are in place: comments, blank lines, key order and keys vcode does not
 * know are all kept, so a hand-annotated file survives the wizard. The file is
 * written 0600 because it holds tokens.
 */
import { existsSync, readFileSync } from 'fs';
import { writeFileAtomicSync } from './atomic-write.js';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  // An unquoted value may carry a trailing ` # comment`.
  const hash = v.search(/\s#/);
  return hash >= 0 ? v.slice(0, hash).trim() : v;
}

/** Parse dotenv text. A key present with an empty value maps to "" — that is
 *  meaningful (VEEPEE_CODE_PROXY_URL= means "no gateway"), so it is kept. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(LINE);
    if (m) out.set(m[1], unquote(m[2]));
  }
  return out;
}

export function readEnvFile(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  try {
    return parseEnv(readFileSync(path, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[VEEPEE Code] warning: could not read ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    return new Map();
  }
}

function quoteIfNeeded(v: string): string {
  return /[\s#"'=]/.test(v) ? JSON.stringify(v) : v;
}

const HEADER = `# VEEPEE Code — endpoints and secrets. Read on every start.
# Structured settings (lockModel, fleet, mcpServers, hooks, lsp) live in settings.json.
# VEEPEE_CODE_PROXY_URL= (empty) means "no gateway" when VEEPEE_CODE_LLM_BACKEND=openai.
`;

/**
 * Set or remove keys. A string sets the key (an empty string writes `KEY=`);
 * null removes every line for it. Keys not mentioned are left untouched.
 */
export function updateEnvFile(path: string, changes: Record<string, string | null>): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf-8').replace(/\n$/, '').split('\n') : HEADER.replace(/\n$/, '').split('\n');
  const pending = new Map(Object.entries(changes));
  const out: string[] = [];
  const written = new Set<string>();
  for (const line of lines) {
    const m = /^\s*#/.test(line) ? null : line.match(LINE);
    if (!m || !pending.has(m[1])) { out.push(line); continue; }
    const value = pending.get(m[1])!;
    // Drop removed keys, and any duplicate line after the first.
    if (value === null || written.has(m[1])) continue;
    out.push(`${m[1]}=${quoteIfNeeded(value)}`);
    written.add(m[1]);
  }
  for (const [key, value] of pending) {
    if (value !== null && !written.has(key)) out.push(`${key}=${quoteIfNeeded(value)}`);
  }
  writeFileAtomicSync(path, out.join('\n') + '\n', 0o600);
}
