#!/usr/bin/env tsx
/**
 * Direct two-model benchmark — bypasses tool-support and speed prechecks.
 * Usage: npx tsx scripts/benchmark-pair.ts <model-a> <model-b> [server-url]
 *
 * Loads each model with a long keep-alive first to defeat cold-start, then
 * runs the full benchmarkModel suite (TEST_SUITE + regressions + exercises +
 * multiturn). Saves both results into ~/.veepee-code/benchmarks/latest.json
 * and prints a side-by-side comparison.
 */

import { Ollama } from 'ollama';
import { Benchmarker, type BenchmarkResult } from '../src/benchmark.js';
import type { ModelProfile } from '../src/models.js';
import { loadConfig } from '../src/config.js';
import chalk from 'chalk';
import { writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const [, , modelA, modelB, urlArg] = process.argv;
if (!modelA || !modelB) {
  console.error('Usage: benchmark-pair.ts <model-a> <model-b> [server-url]');
  process.exit(2);
}

const config = loadConfig();
const url = urlArg || config.proxyUrl;
const ollama = new Ollama({ host: url });
const bench = new Benchmarker(url, []);

function makeProfile(name: string): ModelProfile {
  return {
    name,
    parameterSize: '?',
    parameterCount: 0,
    family: 'unknown',
    families: [],
    quantization: 'unknown',
    contextLength: 0,
    capabilities: ['tools'],
    isLoaded: false,
    serverName: 'proxy',
    diskSize: 0,
    tier: 'heavy' as const,
    score: 0,
  };
}

async function preload(model: string): Promise<void> {
  console.log(chalk.dim(`  preloading ${model}...`));
  try {
    await ollama.chat({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      keep_alive: '60m',
      options: { num_predict: 1, temperature: 0 },
    });
  } catch (e) {
    console.log(chalk.red(`  preload failed: ${e instanceof Error ? e.message : e}`));
  }
}

async function main() {
  console.log(chalk.bold(`Pair benchmark via ${url}`));
  console.log(`  A: ${modelA}`);
  console.log(`  B: ${modelB}\n`);

  const results: BenchmarkResult[] = [];
  for (const name of [modelA, modelB]) {
    await preload(name);
    console.log(chalk.cyan(`\n── benchmarking ${name} ──`));
    const start = Date.now();
    const r = await bench.benchmarkModel(
      makeProfile(name),
      (test, idx, total) => {
        process.stdout.write(`\r  [${idx}/${total}] ${test}                                 `);
      },
      { skipContextProbing: true },
      ollama,
    );
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    const mins = ((Date.now() - start) / 60000).toFixed(1);
    console.log(chalk.green(`  done in ${mins}m — overall ${r.overall}/100`));
    results.push(r);
  }

  results.sort((a, b) => b.overall - a.overall);
  const home = process.env.HOME || '~';
  const outDir = resolve(home, '.veepee-code', 'benchmarks');
  await mkdir(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(resolve(outDir, `pair-${ts}.json`), JSON.stringify(results, null, 2));
  await writeFile(resolve(outDir, 'latest-pair.json'), JSON.stringify(results, null, 2));

  console.log('\n' + Benchmarker.formatTable(results));
  console.log(Benchmarker.formatSummary(results));
  console.log();
  console.log(chalk.bold('  Side-by-side errors:'));
  for (const r of results) {
    console.log(`\n  ${chalk.cyan(r.model)}:`);
    if (r.errors.length === 0) {
      console.log('    (no failures)');
    } else {
      for (const e of r.errors) console.log('    - ' + e);
    }
  }

  await writeFile(
    resolve(__dirname, '..', 'benchmarks', 'pair-latest.json'),
    JSON.stringify(results, null, 2),
  );
}

main().catch(err => {
  console.error(chalk.red('Pair benchmark failed:'), err);
  process.exit(1);
});
