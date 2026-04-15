#!/usr/bin/env tsx
/**
 * fetch-aider-polyglot.ts — Import TypeScript problems from Aider's polyglot-benchmark.
 *
 * Aider's polyglot-benchmark (https://github.com/Aider-AI/polyglot-benchmark, Apache 2.0)
 * contains 225 Exercism problems across multiple languages, each with real test suites.
 * Using these instead of hand-written seed exercises gives vcode execution-based
 * ground truth at industry scale — same corpus Aider, Cursor, and Continue reference
 * in their leaderboards.
 *
 * This script is a ONE-TIME IMPORT. It reads from a locally-cloned copy of the
 * Aider repo and copies the TypeScript problems into benchmarks/exercises-aider/,
 * normalizing them to match our benchmarks/exercises/ convention so the existing
 * runner (src/benchmark-exercises.ts) picks them up automatically.
 *
 * Prerequisites:
 *   git clone https://github.com/Aider-AI/polyglot-benchmark /tmp/polyglot-benchmark
 *
 * Usage:
 *   npx tsx scripts/fetch-aider-polyglot.ts [--source /tmp/polyglot-benchmark] [--limit 50]
 *
 * Notes:
 *   - Only imports TypeScript problems (Aider has Go/Java/Python/Rust variants too).
 *   - Skips problems with non-test-based grading or fixtures that don't translate.
 *   - Does NOT modify benchmarks/exercises/ — writes to benchmarks/exercises-aider/
 *     so the local seed set stays the canonical place for vcode-specific edge cases.
 *   - Rerun to refresh; prior contents of exercises-aider/ are wiped.
 */

import { readdir, readFile, writeFile, mkdir, rm, stat } from 'fs/promises';
import { resolve, dirname, basename, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(REPO_ROOT, 'benchmarks', 'exercises-aider');

const { values } = parseArgs({
  options: {
    source: { type: 'string', default: '/tmp/polyglot-benchmark' },
    limit: { type: 'string', default: '50' },
  },
  strict: false,
});

const SOURCE = resolve(values.source as string);
const LIMIT = parseInt(values.limit as string, 10);

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function importProblem(problemDir: string): Promise<boolean> {
  // Aider's layout: typescript/exercises/practice/<slug>/
  //   .meta/         — hidden metadata
  //   <slug>.ts      — starter (stubbed implementation)
  //   <slug>.test.ts — test suite
  //   README.md      — problem description
  //   package.json   — often present, ignored
  const slug = basename(problemDir);
  const starter = join(problemDir, `${slug}.ts`);
  const testFile = join(problemDir, `${slug}.test.ts`);
  const readme = join(problemDir, 'README.md');

  if (!(await exists(starter)) || !(await exists(testFile)) || !(await exists(readme))) {
    return false;
  }

  const testContent = await readFile(testFile, 'utf-8');
  // Skip problems that import test fixtures we can't carry over
  if (/require\(['"]\.\//.test(testContent) && !/require\(['"]\.\/[a-z-]+['"]\)/.test(testContent)) {
    return false;
  }

  const starterContent = await readFile(starter, 'utf-8');
  const readmeContent = await readFile(readme, 'utf-8');

  const outDir = join(OUT_DIR, slug);
  await mkdir(outDir, { recursive: true });

  // problem.md — prompt for the model. Prepend a brief framing so candidates
  // understand what we want (write code that passes the tests, don't explain).
  const prompt = [
    `# ${slug}`,
    '',
    readmeContent.trim(),
    '',
    '---',
    '',
    '**Your task:** edit the file `solution.ts` so the provided test suite passes.',
    'Do not modify the test file. Use only the existing TypeScript toolchain — no new npm dependencies.',
    'When finished, stop; the test runner will grade the result.',
  ].join('\n');
  await writeFile(join(outDir, 'problem.md'), prompt);

  // Starter — we normalize the filename to solution.ts so the runner convention is
  // uniform across all exercises regardless of their Aider slug.
  await writeFile(join(outDir, 'solution.ts'), starterContent);

  // Test — rewrite imports from `./${slug}` to `./solution` to match the normalized
  // filename. This is a simple find/replace; if anything else imports that path we
  // leave it alone and the runner will surface any breakage.
  const normalizedTest = testContent
    .replace(new RegExp(`from ['"]\\./\\b${slug}\\b['"]`, 'g'), `from './solution'`)
    .replace(new RegExp(`require\\(['"]\\./\\b${slug}\\b['"]\\)`, 'g'), `require('./solution')`);
  await writeFile(join(outDir, 'expected.test.ts'), normalizedTest);

  // metadata.json — follows benchmarks/exercises/*/metadata.json convention
  await writeFile(join(outDir, 'metadata.json'), JSON.stringify({
    source: 'aider-polyglot-benchmark',
    upstream: `https://github.com/Aider-AI/polyglot-benchmark/tree/main/typescript/exercises/practice/${slug}`,
    language: 'typescript',
    timeout_ms: 30000,
    entry_point: 'solution.ts',
    license: 'Apache-2.0 (Aider polyglot-benchmark)',
  }, null, 2));

  return true;
}

async function main() {
  if (!(await exists(SOURCE))) {
    console.error(`ERROR: Aider polyglot-benchmark not found at ${SOURCE}`);
    console.error(`Clone it first:`);
    console.error(`  git clone https://github.com/Aider-AI/polyglot-benchmark ${SOURCE}`);
    process.exit(1);
  }

  const practiceDir = join(SOURCE, 'typescript', 'exercises', 'practice');
  if (!(await exists(practiceDir))) {
    console.error(`ERROR: expected ${practiceDir} to exist — wrong source layout?`);
    process.exit(1);
  }

  // Wipe prior imports so this script is idempotent
  if (await exists(OUT_DIR)) {
    await rm(OUT_DIR, { recursive: true, force: true });
  }
  await mkdir(OUT_DIR, { recursive: true });

  const problems = (await readdir(practiceDir, { withFileTypes: true }))
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  console.log(`Found ${problems.length} candidate problems in ${practiceDir}`);
  console.log(`Target: import up to ${LIMIT} into ${OUT_DIR}`);

  let imported = 0;
  let skipped = 0;
  for (const slug of problems) {
    if (imported >= LIMIT) break;
    const ok = await importProblem(join(practiceDir, slug));
    if (ok) {
      imported += 1;
      if (imported <= 5 || imported % 10 === 0) {
        console.log(`  [${imported}] ${slug}`);
      }
    } else {
      skipped += 1;
    }
  }

  console.log(`\nImported: ${imported}`);
  console.log(`Skipped:  ${skipped} (missing files or fixture imports we couldn't carry)`);
  console.log(`\nRun the benchmark to exercise the new corpus:`);
  console.log(`  npx tsx scripts/benchmark.ts --exercises --dir benchmarks/exercises-aider`);
  console.log(`\nOr extend the default exercise loader in src/benchmark-exercises.ts to include`);
  console.log(`both benchmarks/exercises/ and benchmarks/exercises-aider/.`);
}

main().catch(e => { console.error(e); process.exit(1); });
