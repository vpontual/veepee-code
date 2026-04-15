#!/usr/bin/env tsx
/**
 * extract-corpus.ts — P2 replay corpus extraction.
 *
 * Scans ~/.veepee-code/sessions/ for real user sessions, samples messages
 * that precede a user message (with at least one tool call in the session),
 * and writes JSONL to benchmarks/corpus/latest.jsonl.
 *
 * Each output record:
 *   {
 *     session_id: string,
 *     sample_idx: number,          // which user message within the session
 *     prior_messages: Message[],   // everything before target
 *     target_user_msg: string,
 *     production_response: string | null,   // assistant text that followed in prod
 *     production_tool_calls: Array<{name, args}> | null,
 *     model: string,
 *     timestamp: string,
 *   }
 *
 * Usage:
 *   npx tsx scripts/extract-corpus.ts [--limit 50] [--min-turns 2]
 *
 * See docs/benchmark-improvement-plan.md §P2.
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SESSIONS_DIR = resolve(process.env.HOME || '~', '.veepee-code', 'sessions');
const OUT_DIR = resolve(REPO_ROOT, 'benchmarks', 'corpus');
const OUT_PATH = resolve(OUT_DIR, 'latest.jsonl');

interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments?: Record<string, unknown> } }>;
}

interface Session {
  id: string;
  model: string;
  messages: Msg[];
  createdAt?: string;
  updatedAt?: string;
}

interface Sample {
  session_id: string;
  sample_idx: number;
  prior_messages: Msg[];
  target_user_msg: string;
  production_response: string | null;
  production_tool_calls: Array<{ name: string; args: Record<string, unknown> }> | null;
  model: string;
  timestamp: string;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = Number(valueFor(args, '--limit')) || 50;
  const minTurns = Number(valueFor(args, '--min-turns')) || 2;

  if (!existsSync(SESSIONS_DIR)) {
    console.error(`No sessions dir at ${SESSIONS_DIR}. Nothing to extract.`);
    process.exit(1);
  }

  const files = (await readdir(SESSIONS_DIR)).filter(f => f.endsWith('.json'));
  console.log(`Scanning ${files.length} session files…`);

  const samples: Sample[] = [];

  for (const f of files) {
    if (samples.length >= limit) break;
    try {
      const session = JSON.parse(await readFile(resolve(SESSIONS_DIR, f), 'utf-8')) as Session;
      if (!session.messages || session.messages.length < minTurns * 2) continue;

      const hasToolCall = session.messages.some(
        m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
      );
      if (!hasToolCall) continue;

      let userIdx = 0;
      for (let i = 0; i < session.messages.length; i++) {
        if (samples.length >= limit) break;
        const m = session.messages[i];
        if (m.role !== 'user' || !m.content) continue;

        // Only sample user messages that have prior context (skip the very first)
        if (i === 0) { userIdx++; continue; }

        // Find the assistant response that followed (if any)
        let productionResponse: string | null = null;
        let productionToolCalls: Sample['production_tool_calls'] = null;
        for (let j = i + 1; j < session.messages.length; j++) {
          const next = session.messages[j];
          if (next.role === 'assistant') {
            productionResponse = next.content ?? '';
            if (next.tool_calls && next.tool_calls.length > 0) {
              productionToolCalls = next.tool_calls.map(tc => ({
                name: tc.function.name,
                args: (tc.function.arguments || {}) as Record<string, unknown>,
              }));
            }
            break;
          }
        }

        samples.push({
          session_id: session.id,
          sample_idx: userIdx,
          prior_messages: session.messages.slice(0, i),
          target_user_msg: m.content,
          production_response: productionResponse,
          production_tool_calls: productionToolCalls,
          model: session.model,
          timestamp: session.updatedAt || session.createdAt || new Date().toISOString(),
        });
        userIdx++;
      }
    } catch (err) {
      console.warn(`Skipping ${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  const jsonl = samples.map(s => JSON.stringify(s)).join('\n') + '\n';
  await writeFile(OUT_PATH, jsonl);

  const withToolCalls = samples.filter(s => s.production_tool_calls).length;
  console.log(`Wrote ${samples.length} samples (${withToolCalls} with tool calls) to ${OUT_PATH}`);
}

function valueFor(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
