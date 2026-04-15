#!/usr/bin/env tsx
/**
 * Stamp out benchmarks/predictions/<YYYY-MM-DD>.md from TEMPLATE.md.
 * Run BEFORE a benchmark to commit yourself to a ranking prediction. See §P5.
 *
 * Usage: npx tsx scripts/new-prediction.ts
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRED_DIR = resolve(__dirname, '..', 'benchmarks', 'predictions');
const TEMPLATE = resolve(PRED_DIR, 'TEMPLATE.md');

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const outPath = resolve(PRED_DIR, `${today}.md`);

  if (existsSync(outPath)) {
    console.error(`Prediction for ${today} already exists at ${outPath}. Edit it directly.`);
    process.exit(1);
  }

  const template = await readFile(TEMPLATE, 'utf-8');
  const stamped = template.replace('YYYY-MM-DD', today);
  await mkdir(PRED_DIR, { recursive: true });
  await writeFile(outPath, stamped);
  console.log(`Wrote ${outPath}. Fill it in before running the benchmark.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
