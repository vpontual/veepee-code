#!/usr/bin/env node
/**
 * Live model-path smoke: can the agent actually WRITE a real source file?
 *
 * The output-token ceiling is a harness setting, and when it is too low the
 * arguments of a `write_file` call are cut off mid-JSON — the call never runs,
 * and a model that retries verbatim truncates at the same place until the loop
 * guard ends the run. Measured on a real replay task: four truncated calls, then
 * a timeout. No unit test can see this; it needs a real generation of real size.
 *
 * Runs on whichever model is passed (default: the AGX's gemma4, so this can be
 * run while the main box is busy — the DGX serves one model and should not be
 * asked to do two things at once).
 *
 *   node scripts/model-smoke.mjs [--model gemma4:26b-a4b] [--lines 200]
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { ModelManager } from '../dist/models.js';
import { buildEvalAgent } from '../dist/harness-eval.js';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const model = arg('--model', 'gemma4:26b-a4b');
const lines = Number(arg('--lines', '200'));

const config = loadConfig();
const modelManager = new ModelManager(config);
modelManager.switchTo(model);

const dir = await mkdtemp(join(tmpdir(), 'vcode-modelsmoke-'));
const prevCwd = process.cwd();
let failures = 0;
try {
  process.chdir(dir);
  const { agent } = buildEvalAgent(config, modelManager, dir);
  const target = join(dir, 'src', 'generated.js');
  const started = Date.now();
  const deadline = setTimeout(() => agent.abort(), 240_000);
  let truncated = 0;
  try {
    for await (const ev of agent.run(
      `Create ${target} containing a JavaScript module that exports ${lines} named constants `
      + `(export const K1 = 1; through K${lines} = ${lines}), one per line. Write the whole file in one go.`,
      { permissionMode: 'auto_allow' },
    )) {
      if (ev.type === 'tool_result' && ev.success === false && /cut off mid-JSON/.test(String(ev.error ?? ''))) truncated++;
    }
  } finally { clearTimeout(deadline); }

  const wrote = existsSync(target);
  const body = wrote ? await readFile(target, 'utf-8') : '';
  const count = (body.match(/export const K\d+/g) ?? []).length;
  const ok = wrote && count >= lines * 0.9;
  console.log(`${ok ? 'ok  ' : 'FAIL'} write a ${lines}-line file on ${model}  — ${count} constants, ${Math.round((Date.now() - started) / 1000)}s`);
  if (!ok) failures++;
  console.log(`${truncated === 0 ? 'ok  ' : 'FAIL'} no truncated tool arguments  — ${truncated} truncation(s)`);
  if (truncated > 0) failures++;
} finally {
  process.chdir(prevCwd);
  await rm(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nmodel smoke: PASS' : `\nmodel smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
