/**
 * Regression-test loader (P4).
 *
 * Each failure in production → a JSONL file under benchmarks/regressions/
 * that freezes the exact triggering input as a permanent test. Runners
 * concat these into TEST_SUITE with a heavy weight (default 3×) so they
 * can't be drowned by the other tests.
 *
 * Supported failure_criterion types:
 *   - no_hallucinated_tool   : no tool call whose name isn't in registry ∪ test.tools
 *   - correct_tool           : first tool call is exactly the named tool
 *   - min_response_length    : response text ≥ N chars (catches stream drops)
 *   - contains               : response text contains all of the given strings (case-insensitive)
 *
 * Add a new regression: document the failure, drop a JSONL file, done.
 * See docs/benchmark-improvement-plan.md §P4.
 */

import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
function findRepoRoot(): string {
  const candidates = [
    resolve(__dirname, '..'),
    resolve(__dirname, '..', '..'),
  ];
  for (const c of candidates) {
    if (existsSync(resolve(c, 'benchmarks', 'regressions'))) return c;
  }
  return resolve(__dirname, '..');
}
const REGRESSIONS_DIR = resolve(findRepoRoot(), 'benchmarks', 'regressions');

export interface RegressionRecord {
  id: string;
  date: string;
  description: string;
  user_message: string;
  category?: string;
  tools?: unknown[];
  maxTokens?: number;
  failure_criterion:
    | { type: 'no_hallucinated_tool' }
    | { type: 'correct_tool'; tool: string }
    | { type: 'min_response_length'; min_chars: number }
    | { type: 'contains'; substrings: string[] };
  weight?: number;
}

export async function loadRegressions(): Promise<RegressionRecord[]> {
  if (!existsSync(REGRESSIONS_DIR)) return [];
  const files = (await readdir(REGRESSIONS_DIR)).filter(f => f.endsWith('.jsonl'));
  const out: RegressionRecord[] = [];
  for (const f of files) {
    const src = await readFile(resolve(REGRESSIONS_DIR, f), 'utf-8');
    for (const line of src.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as RegressionRecord;
        if (rec.id && rec.user_message && rec.failure_criterion) out.push(rec);
      } catch {
        // Skip malformed lines rather than crashing the benchmark
      }
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export interface RegressionValidation {
  pass: boolean;
  score: number;
  reason: string;
}

export function validateRegression(
  rec: RegressionRecord,
  response: string,
  toolCalls: Array<{ name: string; args: Record<string, unknown> }> | undefined,
  builtInTools: Set<string>,
): RegressionValidation {
  const crit = rec.failure_criterion;
  switch (crit.type) {
    case 'no_hallucinated_tool': {
      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls at all = model didn't try. That's also a failure for this criterion.
        return { pass: false, score: 0, reason: `${rec.id}: no tool call made` };
      }
      const allowed = new Set(builtInTools);
      for (const t of rec.tools || []) {
        const n = (t as { function?: { name?: string } })?.function?.name;
        if (n) allowed.add(n);
      }
      const bad = toolCalls.map(c => c.name).filter(n => !allowed.has(n));
      if (bad.length > 0) {
        return { pass: false, score: 0, reason: `${rec.id}: HALLUCINATED_TOOL: ${bad.join(', ')}` };
      }
      return { pass: true, score: 100, reason: `${rec.id}: all tool names valid` };
    }
    case 'correct_tool': {
      if (!toolCalls || toolCalls.length === 0) {
        return { pass: false, score: 0, reason: `${rec.id}: no tool call made` };
      }
      const first = toolCalls[0];
      if (first.name !== crit.tool) {
        return { pass: false, score: 0, reason: `${rec.id}: expected ${crit.tool}, got ${first.name}` };
      }
      return { pass: true, score: 100, reason: `${rec.id}: chose ${crit.tool}` };
    }
    case 'min_response_length': {
      if (response.length < crit.min_chars) {
        return {
          pass: false,
          score: 0,
          reason: `${rec.id}: response ${response.length} chars < required ${crit.min_chars} (likely stream drop)`,
        };
      }
      return { pass: true, score: 100, reason: `${rec.id}: ${response.length} chars` };
    }
    case 'contains': {
      const lower = response.toLowerCase();
      const missing = crit.substrings.filter(s => !lower.includes(s.toLowerCase()));
      if (missing.length > 0) {
        return { pass: false, score: 0, reason: `${rec.id}: missing ${missing.join(', ')}` };
      }
      return { pass: true, score: 100, reason: `${rec.id}: all substrings present` };
    }
  }
}
