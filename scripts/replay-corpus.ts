#!/usr/bin/env tsx
/**
 * replay-corpus.ts — P2 replay. Runs a candidate model against each sample in
 * benchmarks/corpus/latest.jsonl, then asks a strong judge model to grade it
 * against a 4-item binary rubric:
 *   1. Did it produce usable code / output?
 *   2. Did it call only real tools (no hallucinated names)?
 *   3. Did it address the user's intent?
 *   4. Did it avoid fabrication (inventing APIs, nonexistent paths)?
 *
 * Outputs a report to benchmarks/corpus/replay-<model>-<timestamp>.json with
 * per-sample verdicts and aggregate pass rate.
 *
 * Usage:
 *   npx tsx scripts/replay-corpus.ts --candidate qwen3-coder:30b \
 *     [--judge gpt-oss:120b] [--proxy http://10.0.153.99:11434] [--limit 30]
 *
 * Exit code is 0 if aggregate pass rate >= 0.80, else 1 (for CI gating).
 *
 * See docs/benchmark-improvement-plan.md §P2.
 */

import { Ollama } from 'ollama';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CORPUS_PATH = resolve(REPO_ROOT, 'benchmarks', 'corpus', 'latest.jsonl');
const OUT_DIR = resolve(REPO_ROOT, 'benchmarks', 'corpus');
const TOOL_REGISTRY_PATH = resolve(REPO_ROOT, 'benchmarks', 'tool-registry.json');

const DEFAULT_JUDGE = 'gpt-oss:120b';
const DEFAULT_PROXY = 'http://10.0.153.99:11434';
const PASS_THRESHOLD = 0.8;

interface Sample {
  session_id: string;
  sample_idx: number;
  prior_messages: Array<Record<string, unknown>>;
  target_user_msg: string;
  production_response: string | null;
  production_tool_calls: Array<{ name: string; args: Record<string, unknown> }> | null;
  model: string;
  timestamp: string;
}

interface Verdict {
  session_id: string;
  sample_idx: number;
  candidate_response: string;
  candidate_tool_calls: Array<{ name: string; args: Record<string, unknown> }>;
  hallucinated_tools: string[];
  judge_rubric: {
    usable: boolean;
    real_tools: boolean;
    addressed_intent: boolean;
    no_fabrication: boolean;
  };
  pass: boolean;
  notes: string;
}

async function main() {
  const args = process.argv.slice(2);
  const candidate = valueFor(args, '--candidate');
  if (!candidate) {
    console.error('Usage: replay-corpus.ts --candidate <model> [--judge <model>] [--proxy <url>] [--limit N]');
    process.exit(2);
  }
  const judge = valueFor(args, '--judge') || DEFAULT_JUDGE;
  const proxy = valueFor(args, '--proxy') || DEFAULT_PROXY;
  const limit = Number(valueFor(args, '--limit')) || Infinity;

  if (!existsSync(CORPUS_PATH)) {
    console.error(`No corpus at ${CORPUS_PATH}. Run scripts/extract-corpus.ts first.`);
    process.exit(2);
  }

  const samples: Sample[] = readFileSync(CORPUS_PATH, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as Sample)
    .slice(0, limit);

  const builtInTools = loadBuiltInTools();
  const ollama = new Ollama({ host: proxy });
  console.log(`Replaying ${samples.length} samples against ${candidate} (judge: ${judge})…`);

  const verdicts: Verdict[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    process.stdout.write(`[${i + 1}/${samples.length}] ${s.session_id}#${s.sample_idx}… `);
    try {
      const { response, toolCalls } = await runCandidate(ollama, candidate, s);
      const hallucinated = toolCalls
        .map(c => c.name)
        .filter(n => builtInTools.size > 0 && !builtInTools.has(n));
      const rubric = await judgeResponse(ollama, judge, s, response, toolCalls);
      const pass = rubric.usable && rubric.real_tools && rubric.addressed_intent && rubric.no_fabrication
        && hallucinated.length === 0;
      verdicts.push({
        session_id: s.session_id,
        sample_idx: s.sample_idx,
        candidate_response: response,
        candidate_tool_calls: toolCalls,
        hallucinated_tools: hallucinated,
        judge_rubric: rubric,
        pass,
        notes: pass ? 'ok' : [
          hallucinated.length ? `hallucinated=${hallucinated.join(',')}` : '',
          !rubric.usable ? 'not-usable' : '',
          !rubric.real_tools ? 'unreal-tool' : '',
          !rubric.addressed_intent ? 'off-intent' : '',
          !rubric.no_fabrication ? 'fabricated' : '',
        ].filter(Boolean).join(' | '),
      });
      console.log(pass ? 'PASS' : `FAIL (${verdicts[verdicts.length - 1].notes})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERROR: ${msg}`);
      verdicts.push({
        session_id: s.session_id,
        sample_idx: s.sample_idx,
        candidate_response: '',
        candidate_tool_calls: [],
        hallucinated_tools: [],
        judge_rubric: { usable: false, real_tools: false, addressed_intent: false, no_fabrication: false },
        pass: false,
        notes: `exception: ${msg}`,
      });
    }
  }

  const passed = verdicts.filter(v => v.pass).length;
  const rate = verdicts.length === 0 ? 0 : passed / verdicts.length;
  const hallucinationCount = verdicts.reduce((n, v) => n + v.hallucinated_tools.length, 0);

  const report = {
    candidate,
    judge,
    proxy,
    corpus_path: CORPUS_PATH,
    total: verdicts.length,
    passed,
    pass_rate: rate,
    hallucination_count: hallucinationCount,
    threshold: PASS_THRESHOLD,
    verdicts,
    generated_at: new Date().toISOString(),
  };

  await mkdir(OUT_DIR, { recursive: true });
  const outFile = resolve(
    OUT_DIR,
    `replay-${candidate.replace(/[:/]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(outFile, JSON.stringify(report, null, 2));

  console.log('');
  console.log(`Candidate : ${candidate}`);
  console.log(`Judge     : ${judge}`);
  console.log(`Pass rate : ${passed}/${verdicts.length} = ${(rate * 100).toFixed(1)}% (threshold ${PASS_THRESHOLD * 100}%)`);
  console.log(`Halluc.   : ${hallucinationCount}`);
  console.log(`Report    : ${outFile}`);

  process.exit(rate >= PASS_THRESHOLD ? 0 : 1);
}

function valueFor(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function loadBuiltInTools(): Set<string> {
  if (!existsSync(TOOL_REGISTRY_PATH)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(TOOL_REGISTRY_PATH, 'utf-8')) as { tools?: string[] };
    return new Set(parsed.tools || []);
  } catch {
    return new Set();
  }
}

async function runCandidate(
  ollama: Ollama,
  model: string,
  sample: Sample,
): Promise<{ response: string; toolCalls: Array<{ name: string; args: Record<string, unknown> }> }> {
  const messages = [...sample.prior_messages, { role: 'user', content: sample.target_user_msg }];
  const resp = await ollama.chat({
    model,
    messages: messages as never,
    stream: false,
    keep_alive: '30m',
    options: { num_predict: 1024, temperature: 0.1 },
  });
  const response = resp.message.content || '';
  const toolCalls = (resp.message.tool_calls || []).map(tc => ({
    name: tc.function.name,
    args: (tc.function.arguments || {}) as Record<string, unknown>,
  }));
  return { response, toolCalls };
}

async function judgeResponse(
  ollama: Ollama,
  judgeModel: string,
  sample: Sample,
  candidateResponse: string,
  candidateToolCalls: Array<{ name: string; args: Record<string, unknown> }>,
): Promise<Verdict['judge_rubric']> {
  const prompt = [
    'You are an impartial evaluator grading a coding-agent response against a real user session.',
    'Return ONLY a JSON object with exactly these four boolean fields:',
    '{"usable": bool, "real_tools": bool, "addressed_intent": bool, "no_fabrication": bool}',
    '',
    'Definitions:',
    '- usable: would the response materially help the user, or is it broken/empty/incoherent?',
    '- real_tools: tool calls (if any) use plausible names; no invented vendor-style tools',
    '- addressed_intent: response is about what the user asked, not off-topic',
    '- no_fabrication: does not invent APIs, file paths, library functions, or facts',
    '',
    '--- USER MESSAGE ---',
    sample.target_user_msg,
    '',
    '--- CANDIDATE RESPONSE ---',
    candidateResponse || '(no text)',
    '',
    '--- CANDIDATE TOOL CALLS ---',
    candidateToolCalls.length
      ? candidateToolCalls.map(c => `- ${c.name}(${JSON.stringify(c.args)})`).join('\n')
      : '(none)',
    '',
    'Return ONLY the JSON, no prose, no code fences.',
  ].join('\n');

  const resp = await ollama.chat({
    model: judgeModel,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    keep_alive: '30m',
    options: { num_predict: 128, temperature: 0 },
  });
  const text = resp.message.content || '';

  // Tolerate code fences or stray prose
  const match = text.match(/\{[\s\S]*?\}/);
  const jsonText = match ? match[0] : text;
  try {
    const parsed = JSON.parse(jsonText) as Verdict['judge_rubric'];
    return {
      usable: !!parsed.usable,
      real_tools: !!parsed.real_tools,
      addressed_intent: !!parsed.addressed_intent,
      no_fabrication: !!parsed.no_fabrication,
    };
  } catch {
    // Judge failed to emit JSON → conservative fail
    return { usable: false, real_tools: false, addressed_intent: false, no_fabrication: false };
  }
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
