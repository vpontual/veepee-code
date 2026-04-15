#!/usr/bin/env tsx
/**
 * Scrape built-in tool names from src/tools/ and write benchmarks/tool-registry.json.
 * Run: npx tsx scripts/generate-tool-registry.ts
 *
 * The generated registry is loaded by src/benchmark.ts and used to hard-fail
 * any test where the model emits a tool call whose name isn't in
 * (registry ∪ per-test synthetic tools). This catches hallucinated tool
 * names like `python_interpreter:execute` or `google:search`.
 *
 * Remote tools (src/tools/remote.ts) are dynamic and excluded — they are
 * discovered at runtime from an external API and aren't a hallucination risk
 * in the benchmark's synthetic suites.
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = resolve(__dirname, '..', 'src', 'tools');
const OUT_PATH = resolve(__dirname, '..', 'benchmarks', 'tool-registry.json');

const NAME_RE = /^\s*name:\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*,/gm;

async function main() {
  const files = (await readdir(TOOLS_DIR)).filter(f =>
    f.endsWith('.ts') && !['types.ts', 'registry.ts', 'remote.ts'].includes(f)
  );

  const names = new Set<string>();
  const perFile: Record<string, string[]> = {};

  for (const file of files) {
    const src = await readFile(resolve(TOOLS_DIR, file), 'utf-8');
    const hits: string[] = [];
    for (const m of src.matchAll(NAME_RE)) {
      hits.push(m[1]);
      names.add(m[1]);
    }
    perFile[file] = hits;
  }

  const sorted = [...names].sort();
  const out = {
    generated_at: new Date().toISOString(),
    generated_by: 'scripts/generate-tool-registry.ts',
    note: 'Built-in tool names scraped from src/tools/. Regenerate after adding/renaming tools.',
    tools: sorted,
    sources: perFile,
  };

  await mkdir(resolve(__dirname, '..', 'benchmarks'), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');

  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  ${sorted.length} tools: ${sorted.join(', ')}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
