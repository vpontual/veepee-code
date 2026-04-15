#!/usr/bin/env tsx
/**
 * run-all-gates.ts — Chain every promotion gate into a single pass/fail verdict.
 *
 * This is the consolidated entry point for deciding whether a candidate model
 * is safe to promote. It runs, in order:
 *
 *   Gate 1: Main benchmark (scripts/benchmark.ts --models <candidate>)
 *           Includes P0 execution-based exercises (local seed + Aider polyglot
 *           imports if present), P1 multi-turn, P3 tool-name validity gate,
 *           P4 regression tests, P5 negative-control check, P6 speed floors,
 *           P7 ceiling-crack tests.
 *
 *   Gate 2: Session-replay corpus (scripts/replay-corpus.ts)
 *           30 real user sessions from ~/.veepee-code/sessions/, judged by
 *           local Ollama with 4-item binary rubric. CI threshold: 80% pass.
 *
 *   Gate 3: Git-history replay (scripts/replay-git-history.ts)
 *           Real commits from this repo, replayed against the candidate with
 *           worktree checkout + typecheck verdict. CI threshold: 50% pass.
 *
 * Any gate's non-zero exit code kills the chain (unless --continue-on-fail).
 * A combined verdict JSON is written to benchmarks/gates/<model>-<date>.json.
 *
 * This is the script to run before ever proposing a model switch. The
 * Llama Rider post-mortem (see docs/benchmark-improvement-plan.md) showed
 * that no single gate alone predicts production — you need all three.
 *
 * Usage:
 *   npx tsx scripts/run-all-gates.ts --candidate qwen3-coder:30b
 *   npx tsx scripts/run-all-gates.ts --candidate qwen3-coder:30b --judge gpt-oss:120b
 *   npx tsx scripts/run-all-gates.ts --candidate qwen3-coder:30b --skip-git  # faster iteration
 *   npx tsx scripts/run-all-gates.ts --candidate qwen3-coder:30b --continue-on-fail
 */

import { spawnSync } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const GATES_DIR = resolve(REPO_ROOT, 'benchmarks', 'gates');

const { values } = parseArgs({
  options: {
    candidate: { type: 'string' },
    judge: { type: 'string', default: 'gpt-oss:120b' },
    proxy: { type: 'string', default: 'http://10.0.153.99:11434' },
    'skip-benchmark': { type: 'boolean', default: false },
    'skip-corpus': { type: 'boolean', default: false },
    'skip-git': { type: 'boolean', default: false },
    'continue-on-fail': { type: 'boolean', default: false },
    'corpus-limit': { type: 'string', default: '30' },
    'git-limit': { type: 'string', default: '20' },
  },
  strict: false,
});

if (!values.candidate) {
  console.error('ERROR: --candidate <model> required');
  process.exit(2);
}

const CANDIDATE = values.candidate as string;
const JUDGE = values.judge as string;
const PROXY = values.proxy as string;
const CONTINUE = values['continue-on-fail'] as boolean;

type GateName = 'benchmark' | 'corpus' | 'git-history';
interface GateResult {
  gate: GateName;
  ran: boolean;
  exitCode: number | null;
  durationMs: number;
  summary: string;
}

function runGate(gate: GateName, args: string[]): GateResult {
  const start = Date.now();
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  GATE: ${gate}`);
  console.log(`  ${'npx tsx ' + args.join(' ')}`);
  console.log(`${'='.repeat(70)}\n`);

  const result = spawnSync('npx', ['tsx', ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    // No explicit timeout; each gate has its own internal timing
  });

  const durationMs = Date.now() - start;
  const exitCode = result.status;
  const summary = exitCode === 0
    ? `passed in ${(durationMs / 1000).toFixed(0)}s`
    : `FAILED with exit ${exitCode} after ${(durationMs / 1000).toFixed(0)}s`;

  return { gate, ran: true, exitCode, durationMs, summary };
}

async function main() {
  await mkdir(GATES_DIR, { recursive: true });

  const results: GateResult[] = [];
  let hardStop = false;

  // Gate 1 — main benchmark (with exercises, multiturn, regressions, tool gate)
  if (!values['skip-benchmark']) {
    const r = runGate('benchmark', [
      'scripts/benchmark.ts',
      '--models', CANDIDATE,
      '--force',
    ]);
    results.push(r);
    if (r.exitCode !== 0 && !CONTINUE) hardStop = true;
  } else {
    results.push({ gate: 'benchmark', ran: false, exitCode: null, durationMs: 0, summary: 'skipped' });
  }

  // Gate 2 — session-replay corpus
  if (!hardStop && !values['skip-corpus']) {
    const r = runGate('corpus', [
      'scripts/replay-corpus.ts',
      '--candidate', CANDIDATE,
      '--judge', JUDGE,
      '--proxy', PROXY,
      '--limit', values['corpus-limit'] as string,
    ]);
    results.push(r);
    if (r.exitCode !== 0 && !CONTINUE) hardStop = true;
  } else if (!values['skip-corpus']) {
    results.push({ gate: 'corpus', ran: false, exitCode: null, durationMs: 0, summary: 'skipped (prior gate failed)' });
  } else {
    results.push({ gate: 'corpus', ran: false, exitCode: null, durationMs: 0, summary: 'skipped' });
  }

  // Gate 3 — git-history replay
  if (!hardStop && !values['skip-git']) {
    const r = runGate('git-history', [
      'scripts/replay-git-history.ts',
      '--candidate', CANDIDATE,
      '--proxy', PROXY,
      '--limit', values['git-limit'] as string,
    ]);
    results.push(r);
  } else if (!values['skip-git']) {
    results.push({ gate: 'git-history', ran: false, exitCode: null, durationMs: 0, summary: 'skipped (prior gate failed)' });
  } else {
    results.push({ gate: 'git-history', ran: false, exitCode: null, durationMs: 0, summary: 'skipped' });
  }

  // Verdict
  const ranGates = results.filter(r => r.ran);
  const passedGates = ranGates.filter(r => r.exitCode === 0);
  const overallPass = ranGates.length > 0 && passedGates.length === ranGates.length;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  VERDICT FOR ${CANDIDATE}`);
  console.log(`${'='.repeat(70)}`);
  for (const r of results) {
    const tag = !r.ran ? '—' : r.exitCode === 0 ? '✓' : '✗';
    console.log(`  ${tag} ${r.gate.padEnd(12)} ${r.summary}`);
  }
  console.log(`  ${overallPass ? 'PROMOTION ELIGIBLE ✓' : 'DO NOT PROMOTE ✗'}`);
  console.log(`${'='.repeat(70)}\n`);

  const modelSlug = CANDIDATE.replace(/[:\/]/g, '-');
  const reportPath = resolve(GATES_DIR, `${modelSlug}-${new Date().toISOString().slice(0, 10)}.json`);
  await writeFile(reportPath, JSON.stringify({
    candidate: CANDIDATE,
    timestamp: new Date().toISOString(),
    overall_pass: overallPass,
    gates: results,
  }, null, 2));
  console.log(`Report: ${reportPath}`);

  process.exit(overallPass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
