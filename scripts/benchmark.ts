#!/usr/bin/env tsx
/**
 * Fleet benchmark runner — mirrors the /benchmark command but runs from the terminal.
 *
 * Usage:
 *   npx tsx scripts/benchmark.ts                        # benchmark all servers (8 tok/s floor, default)
 *   npx tsx scripts/benchmark.ts --list                 # show saved results without running
 *   npx tsx scripts/benchmark.ts --force                # re-benchmark already-benchmarked models
 *   npx tsx scripts/benchmark.ts --server dgx-spark     # one server only
 *   npx tsx scripts/benchmark.ts --models qwen3:8b,...  # specific models only
 *   npx tsx scripts/benchmark.ts --min-tps=5            # lower speed floor
 *   npx tsx scripts/benchmark.ts --min-tps=0            # disable speed filter entirely
 *
 * Results are saved to ~/.veepee-code/benchmarks/latest.json
 * Fleet servers are read from ~/.veepee-code/vcode.config.json
 */

import { Benchmarker } from '../src/benchmark.js';
import { loadConfig } from '../src/config.js';
import { ModelManager } from '../src/models.js';
import chalk from 'chalk';
import { writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const force = args.includes('--force');
const serverFilter = args.find(a => a.startsWith('--server='))?.split('=')[1]
  ?? (args.includes('--server') ? args[args.indexOf('--server') + 1] : undefined);
const modelsArg = args.find(a => a.startsWith('--models='))?.split('=')[1]
  ?? (args.includes('--models') ? args[args.indexOf('--models') + 1] : undefined);
const specificModels = modelsArg ? modelsArg.split(',').map(m => m.trim()) : null;
const minTpsArg = args.find(a => a.startsWith('--min-tps='))?.split('=')[1]
  ?? (args.includes('--min-tps') ? args[args.indexOf('--min-tps') + 1] : undefined);
const minTps = minTpsArg !== undefined ? parseInt(minTpsArg, 10) : 8; // default: 8 tok/s floor

async function main() {
  const config = loadConfig();
  const benchmarker = new Benchmarker(config.proxyUrl, config.fleet);

  if (listOnly) {
    const results = await benchmarker.loadLatest();
    if (!results || results.length === 0) {
      console.log('No benchmark results. Run without --list to generate.');
      return;
    }
    console.log(Benchmarker.formatTable(results));
    console.log(Benchmarker.formatSummary(results));
    return;
  }

  if (config.fleet.length === 0) {
    console.log(chalk.yellow('Warning: no fleet configured in vcode.config.json. Running against proxy only.'));
    console.log(chalk.dim('  Add a "fleet" array to enable per-server benchmarking.\n'));
  } else {
    const fleet = serverFilter
      ? config.fleet.filter(s => s.name === serverFilter)
      : config.fleet;

    if (fleet.length === 0) {
      console.error(`No server named "${serverFilter}" in fleet config.`);
      process.exit(1);
    }

    console.log(chalk.bold(`Fleet benchmark — ${fleet.length} server(s): ${fleet.map(s => s.name).join(', ')}`));
    if (specificModels) console.log(chalk.dim(`  Model filter: ${specificModels.join(', ')}`));
    if (minTps > 0) console.log(chalk.dim(`  Min speed: ${minTps} tok/s (pass --min-tps=0 to disable)`));
    if (force) console.log(chalk.dim('  Force mode: re-benchmarking already-benchmarked models'));
    console.log();
  }

  // Discover models through proxy for metadata enrichment
  const modelManager = new ModelManager(config);
  try {
    await modelManager.discover();
  } catch {
    console.log(chalk.dim('Could not reach proxy — proceeding with minimal model metadata\n'));
  }
  let allModels = modelManager.getAllModels();

  // Apply --models filter if specified
  if (specificModels) {
    allModels = allModels.filter(m => specificModels.includes(m.name));
  }

  const results = await benchmarker.benchmarkAll(allModels, {
    skipContextProbing: true,
    skipExisting: !force,
    minTps,
    modelNames: specificModels ? new Set(specificModels) : undefined,
    onProgress: (model, test, mi, mt, ti, tt) => {
      process.stdout.write(`\r  [${mi}/${mt}] ${model} — ${test} (${ti}/${tt})                    `);
    },
    onStatusUpdate: (msg) => {
      // Clear the progress line before printing status
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      console.log(msg);
    },
  });

  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  console.log('\n' + Benchmarker.formatTable(results));
  console.log(Benchmarker.formatSummary(results));

  const savedPath = `${process.env.HOME}/.veepee-code/benchmarks/latest.json`;
  console.log(chalk.dim(`Results saved to ${savedPath}`));

  // Also save a copy to the repo so results are tracked in git
  const repoResultsPath = resolve(__dirname, '..', 'benchmarks', 'results.json');
  await writeFile(repoResultsPath, JSON.stringify(results, null, 2));
  console.log(chalk.dim(`Repo copy saved to ${repoResultsPath}`));
  console.log(chalk.dim('Run /benchmark results inside the TUI to view at any time.'));
}

main().catch(err => {
  console.error(chalk.red('Benchmark failed:'), err.message);
  process.exit(1);
});
