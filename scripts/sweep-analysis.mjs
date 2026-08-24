#!/usr/bin/env node
/**
 * Post-hoc analysis of a sweep's EVIDENCE, not just its verdicts.
 *
 * A pass rate uses one bit per task. The transcripts hold every tool call and
 * every failure, so a task that ran out of budget still says a great deal about
 * whether the harness worked for the 40 minutes it was alive. With one sweep to
 * draw on, throwing that away would be a choice.
 *
 * The question is not "how many tasks passed". It is: across every tool call the
 * agent made, how many failures were the HARNESS's fault — an edit that would
 * not apply, arguments cut off mid-stream, a file it could not write, a request
 * the server refused because we built it wrong?
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = join(process.env.HOME, '.veepee-code', 'repo-evals', 'evidence');
const since = process.argv[2] ? new Date(process.argv[2]) : new Date(Date.now() - 6 * 3600_000);

// Signatures of a HARNESS-caused tool failure: vcode failed to do its job,
// whatever the model asked for.
const HARNESS_SIGNATURES = [
  [/cut off mid-JSON|arrived truncated/i, 'tool-call arguments truncated'],
  [/old_string not found|could not locate exact position/i, 'edit could not be applied'],
  [/ENOENT|no such file or directory/i, 'file or directory missing on write'],
  [/maximum context length|context_length_exceeded/i, 'request exceeded the context window'],
  [/Permission denied/i, 'permission gate refused a call'],
  [/exceeded its .* budget|abandoned/i, 'tool abandoned by the registry timeout'],
  [/not in subagent allowedModels/i, 'subagent model rejected'],
  [/Diagnostics were not available/i, 'LSP diagnostics unavailable'],
];
// Failures that are the WORLD answering honestly: a test that fails, a command
// that exits non-zero because the code is wrong. Those are the agent's problem.
const HONEST_SIGNATURES = [
  [/Exit code \d+/i, 'command exited non-zero (usually a failing test)'],
  [/No matches found/i, 'search found nothing'],
];

const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
let tasks = 0, calls = 0, failures = 0;
const harness = new Map(), honest = new Map(), unknown = [];

for (const f of files) {
  const raw = JSON.parse(await readFile(join(dir, f), 'utf-8'));
  const stamp = /(\d{4}-\d{2}-\d{2}T[\d-]+)\.json$/.exec(f)?.[1]?.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z');
  if (stamp && new Date(stamp) < since) continue;
  tasks++;
  for (const t of raw.transcript ?? []) {
    if (t.kind === 'tool_call') calls++;
    if (t.kind !== 'tool_result' || t.success !== false) continue;
    failures++;
    const text = String(t.content ?? '');
    const h = HARNESS_SIGNATURES.find(([re]) => re.test(text));
    const o = HONEST_SIGNATURES.find(([re]) => re.test(text));
    if (h) harness.set(h[1], (harness.get(h[1]) ?? 0) + 1);
    else if (o) honest.set(o[1], (honest.get(o[1]) ?? 0) + 1);
    else unknown.push(`${t.name}: ${text.slice(0, 100)}`);
  }
}

const harnessTotal = [...harness.values()].reduce((a, b) => a + b, 0);
console.log(`tasks analysed: ${tasks}   tool calls: ${calls}   tool failures: ${failures}\n`);
console.log(`HARNESS-caused failures: ${harnessTotal}${harnessTotal ? '' : '  ← the number that matters'}`);
for (const [k, v] of [...harness].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log(`\nHONEST failures (the world answering): ${[...honest.values()].reduce((a, b) => a + b, 0)}`);
for (const [k, v] of [...honest].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log(`\nUNCLASSIFIED: ${unknown.length}  (counted as harness until read)`);
for (const u of unknown.slice(0, 12)) console.log(`  - ${u}`);
if (calls > 0) {
  const rate = ((harnessTotal + unknown.length) / calls * 100).toFixed(2);
  console.log(`\nharness-attributable failure rate: ${rate}% of ${calls} tool calls`);
}
