#!/usr/bin/env node
/**
 * Live fleet smoke test. Run BEFORE committing anything that touches how vcode
 * talks to the fleet — routing, subagents, retries, the adapter.
 *
 * It exists because unit tests assert that the code says what was meant, not
 * that the system does what was claimed. A subagent-routing change shipped on
 * 2026-08-24 with green unit tests and no live spawn; the tests compared model
 * NAMES, which cannot tell you whether a second generation would have landed on
 * a box that cannot host one.
 *
 * Checks, in order of what actually breaks:
 *   1. every configured fleet endpoint answers;
 *   2. a subagent spawns, returns, and lands on hardware OTHER than the
 *      parent's — the DGX serves one model and a concurrent second generation
 *      of it is a crash, not a slowdown.
 */
import { SubAgentManager } from '../dist/subagent.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { loadConfig } from '../dist/config.js';

const config = loadConfig();
const parentModel = config.lockModel || config.model;
let failures = 0;

const endpoints = [
  ['gateway', `${config.proxyUrl}/api/tags`],
  // Ollama and vLLM do not share a health endpoint: vLLM answers /health,
  // Ollama has no such route and 404s — which looked like a dead Nano on the
  // first run of this script. Probe each for what it actually serves.
  ...(config.fleet ?? []).map((f) => [
    f.name,
    f.url.includes(':11434') ? `${f.url}/api/tags` : `${f.url}/health`,
  ]),
];
for (const [name, url] of endpoints) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    console.log(`${res.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${res.status} ${url}`);
    if (!res.ok) failures++;
  } catch (err) {
    console.log(`FAIL ${name.padEnd(14)} ${String(err).slice(0, 60)} ${url}`);
    failures++;
  }
}

const mgr = new SubAgentManager(config, new ToolRegistry(), null);
mgr.setDefaultModel(parentModel);
const started = Date.now();
const { result } = await mgr.runTask({ prompt: 'Reply with exactly: SUBAGENT OK', maxTurns: 1 });
const offParent = result?.model && result.model !== parentModel;
console.log(`${result?.success && offParent ? 'ok  ' : 'FAIL'} subagent      model=${result?.model} success=${result?.success} ${Date.now() - started}ms`);
if (!result?.success) { console.log(`     error: ${result?.error}`); failures++; }
if (!offParent) { console.log(`     routed onto the PARENT's model (${parentModel}) — that box cannot host two generations`); failures++; }

console.log(failures === 0 ? '\nfleet smoke: PASS' : `\nfleet smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
