/**
 * Sanity-check every harness task without spending a model call.
 *
 * Two things have to be true of a task before it is worth running:
 *
 *   1. Its grader FAILS on the untouched workspace. A grader that cannot fail
 *      scores nothing — it silently inflates the suite for every future commit.
 *   2. Its visible `npm test` starts in the state the task assumes. A task
 *      whose premise is "the suite is failing" is broken if the suite is green,
 *      and a task that starts red by accident measures something nobody chose.
 *
 * This mirrors the grading path in src/harness-eval.ts exactly: the grading
 * copy lives inside the repo so `vitest/config` resolves, node_modules is
 * symlinked in, and only verify.test.ts runs.
 *
 *   node scripts/check-harness-tasks.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const tasksDir = join(repo, 'benchmarks', 'harness');

/** Tasks whose visible suite is red on purpose before the agent starts. */
const STARTS_RED = new Set(['fix-failing-test', 'trace-cross-file-bug', 'naive-fix-regresses']);

function runVitest(dir, include) {
  writeFileSync(
    join(dir, 'vitest.config.mjs'),
    "import { defineConfig } from 'vitest/config';\n" +
    `export default defineConfig({ test: { include: ${JSON.stringify(include)}, testTimeout: 20000 } });\n`,
  );
  const bin = join(repo, 'node_modules', '.bin', 'vitest');
  const r = spawnSync(bin, ['run'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function stage(task) {
  const dir = join(repo, `.harness-check-${task}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(tasksDir, task, 'workspace'), dir, { recursive: true });
  try {
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
  } catch { /* already there */ }
  return dir;
}

const tasks = readdirSync(tasksDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let bad = 0;
const rows = [];

for (const task of tasks) {
  const taskDir = join(tasksDir, task);
  for (const required of ['task.md', 'metadata.json', 'verify.test.ts', 'workspace']) {
    if (!existsSync(join(taskDir, required))) {
      console.error(`${task}: missing ${required}`);
      bad++;
    }
  }
  try {
    JSON.parse(readFileSync(join(taskDir, 'metadata.json'), 'utf8'));
  } catch (err) {
    console.error(`${task}: metadata.json is not valid JSON — ${err.message}`);
    bad++;
  }

  // 1. The grader must fail on the untouched workspace.
  const gradeDir = stage(task);
  cpSync(join(taskDir, 'verify.test.ts'), join(gradeDir, 'verify.test.ts'));
  const graded = runVitest(gradeDir, ['verify.test.ts']);
  rmSync(gradeDir, { recursive: true, force: true });

  // 2. The visible suite must start in the state the task assumes.
  const visibleDir = stage(task);
  const visible = runVitest(visibleDir, ['**/*.test.ts', '**/*.test.js']);
  rmSync(visibleDir, { recursive: true, force: true });

  const graderFails = graded.code !== 0;
  const expectRed = STARTS_RED.has(task);
  const visibleOk = expectRed ? visible.code !== 0 : visible.code === 0;

  if (!graderFails) {
    console.error(`\n${task}: GRADER PASSES ON THE UNTOUCHED WORKSPACE — it cannot measure anything`);
    bad++;
  }
  if (!visibleOk) {
    console.error(`\n${task}: visible suite is ${visible.code === 0 ? 'green' : 'red'}, expected ${expectRed ? 'red' : 'green'}`);
    console.error(visible.out.split('\n').filter(Boolean).slice(-12).join('\n'));
    bad++;
  }

  rows.push({
    task,
    grader: graderFails ? 'fails (good)' : 'PASSES (bad)',
    visible: `${visible.code === 0 ? 'green' : 'red'}${expectRed ? ' (red by design)' : ''}`,
  });
}

const w = Math.max(...rows.map((r) => r.task.length));
console.log('');
for (const r of rows) {
  console.log(`  ${r.task.padEnd(w)}  grader ${r.grader.padEnd(13)} visible ${r.visible}`);
}
console.log(`\n${tasks.length} tasks, ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
