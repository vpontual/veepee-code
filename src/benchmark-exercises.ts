/**
 * Execution-based code-gen benchmark (P0).
 *
 * For each exercise under benchmarks/exercises/<name>/:
 *   - problem.md         → user prompt
 *   - starter.ts (opt.)  → seed file copied into the scratch dir
 *   - expected.test.ts   → vitest file that validates the model's solution
 *   - metadata.json      → { timeout_ms, language, description }
 *
 * The runner gives the model a scoped toolbox (write_file, read_file, edit_file,
 * list_files, shell) that operates inside a per-run scratch directory. The model
 * runs an agentic loop (up to MAX_TURNS) until it stops emitting tool calls,
 * then vitest runs the expected test file. Binary pass/fail — no partial credit.
 *
 * Design rationale: keyword-based CodeGen validators produce the "benchmark
 * saturation at 100/100" problem. Execution-based ground truth is the only
 * reliable coding signal. See docs/benchmark-improvement-plan.md §P0.
 */

import { Ollama } from 'ollama';
import { readdir, readFile, writeFile, mkdir, rm, stat, cp } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, join, normalize, relative } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/benchmark-exercises.ts → repo root is two dirs up once built into dist/,
// one up at dev time. We walk upward looking for benchmarks/exercises.
function findRepoRoot(): string {
  const candidates = [
    resolve(__dirname, '..'),
    resolve(__dirname, '..', '..'),
  ];
  for (const c of candidates) {
    if (existsSync(resolve(c, 'benchmarks', 'exercises'))) return c;
  }
  return resolve(__dirname, '..');
}
const REPO_ROOT = findRepoRoot();
const EXERCISES_DIR = resolve(REPO_ROOT, 'benchmarks', 'exercises');
const MULTITURN_DIR = resolve(REPO_ROOT, 'benchmarks', 'multiturn');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'benchmarks', 'scratch');

const MAX_TURNS = 8;
const DEFAULT_TIMEOUT_MS = 120_000;
const SHELL_TIMEOUT_MS = 20_000;

interface Exercise {
  name: string;
  problem: string;
  starterPath: string | null;
  testPath: string;
  dir: string;
  timeoutMs: number;
}

export interface ExerciseResult {
  name: string;
  pass: boolean;
  reason: string;
  turns: number;
  durationMs: number;
  toolCallCount: number;
  stderr?: string;
}

export interface ExerciseSuiteResult {
  passed: number;
  total: number;
  score: number;       // 0-100: pass_rate * 100
  results: ExerciseResult[];
}

/** Load all exercises from benchmarks/exercises/ */
export async function loadExercises(): Promise<Exercise[]> {
  if (!existsSync(EXERCISES_DIR)) return [];
  const entries = await readdir(EXERCISES_DIR, { withFileTypes: true });
  const out: Exercise[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = resolve(EXERCISES_DIR, e.name);
    const problemPath = resolve(dir, 'problem.md');
    const testPath = resolve(dir, 'expected.test.ts');
    const metaPath = resolve(dir, 'metadata.json');
    const starterPath = resolve(dir, 'starter.ts');
    if (!existsSync(problemPath) || !existsSync(testPath)) continue;

    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as { timeout_ms?: number };
        if (typeof meta.timeout_ms === 'number') timeoutMs = meta.timeout_ms;
      } catch { /* ignore */ }
    }

    out.push({
      name: e.name,
      problem: await readFile(problemPath, 'utf-8'),
      starterPath: existsSync(starterPath) ? starterPath : null,
      testPath,
      dir,
      timeoutMs,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Scoped tool schemas the model sees for every exercise. */
const EXERCISE_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the working directory. Use relative paths.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path (e.g. "solution.ts")' },
          content: { type: 'string', description: 'Full file contents' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file in the working directory. Use relative paths.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in a file. Fails if old_string is not unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the working directory.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a shell command in the working directory. Timeout 20s.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

/** Resolve a user-supplied relative path inside the scratch dir. Throws on escape. */
function scopedPath(scratch: string, p: string): string {
  const abs = normalize(resolve(scratch, p));
  const rel = relative(scratch, abs);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`Path ${p} escapes scratch dir`);
  }
  return abs;
}

async function execTool(
  scratch: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'write_file': {
        const p = scopedPath(scratch, String(args.path));
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, String(args.content ?? ''));
        return `wrote ${args.path}`;
      }
      case 'read_file': {
        const p = scopedPath(scratch, String(args.path));
        if (!existsSync(p)) return `error: ${args.path} does not exist`;
        return await readFile(p, 'utf-8');
      }
      case 'edit_file': {
        const p = scopedPath(scratch, String(args.path));
        if (!existsSync(p)) return `error: ${args.path} does not exist`;
        const before = await readFile(p, 'utf-8');
        const oldStr = String(args.old_string);
        const newStr = String(args.new_string);
        const count = before.split(oldStr).length - 1;
        if (count === 0) return `error: old_string not found in ${args.path}`;
        if (count > 1) return `error: old_string not unique in ${args.path} (${count} occurrences)`;
        await writeFile(p, before.replace(oldStr, newStr));
        return `edited ${args.path}`;
      }
      case 'list_files': {
        const files = await readdir(scratch);
        return files.join('\n');
      }
      case 'shell': {
        const cmd = String(args.command || '');
        return await runShell(cmd, scratch, SHELL_TIMEOUT_MS);
      }
    }
    return `error: unknown tool ${name}`;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise(resolveP => {
    const proc = spawn('bash', ['-c', cmd], { cwd, env: process.env });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolveP(out + `\n[TIMEOUT ${timeoutMs}ms]`);
    }, timeoutMs);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      clearTimeout(timer);
      resolveP(out + `\n[exit ${code}]`);
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolveP(`error: ${err.message}`);
    });
  });
}

const VITEST_BIN = resolve(REPO_ROOT, 'node_modules', '.bin', 'vitest');

/** Run vitest against a single test file in the scratch dir.
 *  Writes a local vitest.config.mjs and spawns the repo's vitest binary with cwd=scratch,
 *  which lets vitest resolve node_modules via normal upward walk. */
async function runVitest(scratch: string, timeoutMs: number): Promise<{ pass: boolean; stderr: string }> {
  // Minimal config scoped to the single test file in the scratch dir
  const configPath = resolve(scratch, 'vitest.config.mjs');
  const config = `import { defineConfig } from 'vitest/config';\n` +
    `export default defineConfig({ test: { include: ['expected.test.ts'], testTimeout: 15000 } });\n`;
  await writeFile(configPath, config);

  return new Promise(resolveP => {
    const proc = spawn(
      VITEST_BIN,
      ['run'],
      { cwd: scratch, env: { ...process.env, CI: '1' } },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolveP({ pass: false, stderr: (err + out + `\n[TIMEOUT ${timeoutMs}ms]`).slice(-4000) });
    }, timeoutMs);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      clearTimeout(timer);
      resolveP({ pass: code === 0, stderr: (err + out).slice(-4000) });
    });
    proc.on('error', e => {
      clearTimeout(timer);
      resolveP({ pass: false, stderr: `spawn error: ${e.message}` });
    });
  });
}

async function prepareScratch(ex: Exercise): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const scratch = resolve(SCRATCH_ROOT, `${ex.name}-${randomUUID().slice(0, 8)}`);
  await mkdir(scratch, { recursive: true });
  // Copy expected.test.ts
  await cp(ex.testPath, resolve(scratch, 'expected.test.ts'));
  if (ex.starterPath) {
    await cp(ex.starterPath, resolve(scratch, 'solution.ts'));
  }
  return scratch;
}

/** Run a single exercise against a model. */
export async function runExercise(
  ex: Exercise,
  modelName: string,
  ollama: Ollama,
): Promise<ExerciseResult> {
  const start = Date.now();
  const scratch = await prepareScratch(ex);
  let toolCallCount = 0;

  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content:
        'You are a coding agent. Use the provided tools to create files in the working directory. ' +
        'When the solution is complete and correct, stop calling tools and briefly confirm you are done.',
    },
    { role: 'user', content: ex.problem },
  ];

  let turns = 0;
  try {
    for (let t = 0; t < MAX_TURNS; t++) {
      turns++;
      const resp = await ollama.chat({
        model: modelName,
        messages: messages as never,
        tools: EXERCISE_TOOLS as never,
        stream: false,
        keep_alive: '30m',
        options: { num_predict: 2048, temperature: 0.1 },
      });

      const msg = resp.message;
      messages.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls,
      });

      const calls = msg.tool_calls || [];
      if (calls.length === 0) break;

      for (const tc of calls) {
        toolCallCount++;
        const name = tc.function.name;
        const args = (tc.function.arguments || {}) as Record<string, unknown>;
        const result = await execTool(scratch, name, args);
        messages.push({
          role: 'tool',
          content: result.length > 4000 ? result.slice(0, 4000) + '...[truncated]' : result,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: ex.name,
      pass: false,
      reason: `agent loop error: ${msg}`,
      turns,
      durationMs: Date.now() - start,
      toolCallCount,
    };
  }

  // Verify the model actually wrote a solution file
  const solutionPath = resolve(scratch, 'solution.ts');
  if (!existsSync(solutionPath)) {
    return {
      name: ex.name,
      pass: false,
      reason: 'no solution.ts written',
      turns,
      durationMs: Date.now() - start,
      toolCallCount,
    };
  }

  // Run the test
  const { pass, stderr } = await runVitest(scratch, ex.timeoutMs);
  // Clean up scratch unless failing — keep failing dirs for debugging
  if (pass) {
    try { await rm(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return {
    name: ex.name,
    pass,
    reason: pass ? 'all tests passed' : 'test failures',
    turns,
    durationMs: Date.now() - start,
    toolCallCount,
    stderr: pass ? undefined : stderr,
  };
}

/** Run the entire exercise suite against one model. */
export async function runExerciseSuite(
  modelName: string,
  ollama: Ollama,
  onProgress?: (ex: string, idx: number, total: number, result?: ExerciseResult) => void,
): Promise<ExerciseSuiteResult> {
  const exercises = await loadExercises();
  const results: ExerciseResult[] = [];
  for (let i = 0; i < exercises.length; i++) {
    const ex = exercises[i];
    onProgress?.(ex.name, i + 1, exercises.length);
    const r = await runExercise(ex, modelName, ollama);
    results.push(r);
    onProgress?.(ex.name, i + 1, exercises.length, r);
  }
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const score = total === 0 ? 0 : Math.round((passed / total) * 100);
  return { passed, total, score, results };
}

// ─── Multi-turn exercises (P1) ───────────────────────────────────────────────

interface MultiturnExercise {
  name: string;
  turns: string[];
  starterPath: string | null;
  testPath: string;
  dir: string;
  timeoutMs: number;
}

export async function loadMultiturnExercises(): Promise<MultiturnExercise[]> {
  if (!existsSync(MULTITURN_DIR)) return [];
  const entries = await readdir(MULTITURN_DIR, { withFileTypes: true });
  const out: MultiturnExercise[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = resolve(MULTITURN_DIR, e.name);
    const turnsPath = resolve(dir, 'turns.json');
    const testPath = resolve(dir, 'expected.test.ts');
    const metaPath = resolve(dir, 'metadata.json');
    const starterPath = resolve(dir, 'starter.ts');
    if (!existsSync(turnsPath) || !existsSync(testPath)) continue;

    let turns: string[] = [];
    try {
      const raw = JSON.parse(await readFile(turnsPath, 'utf-8')) as { turns?: string[] };
      turns = raw.turns || [];
    } catch {
      continue;
    }
    if (turns.length === 0) continue;

    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as { timeout_ms?: number };
        if (typeof meta.timeout_ms === 'number') timeoutMs = meta.timeout_ms;
      } catch { /* ignore */ }
    }

    out.push({
      name: e.name,
      turns,
      starterPath: existsSync(starterPath) ? starterPath : null,
      testPath,
      dir,
      timeoutMs,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function prepareMultiturnScratch(ex: MultiturnExercise): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const scratch = resolve(SCRATCH_ROOT, `mt-${ex.name}-${randomUUID().slice(0, 8)}`);
  await mkdir(scratch, { recursive: true });
  await cp(ex.testPath, resolve(scratch, 'expected.test.ts'));
  if (ex.starterPath) await cp(ex.starterPath, resolve(scratch, 'solution.ts'));
  return scratch;
}

export async function runMultiturnExercise(
  ex: MultiturnExercise,
  modelName: string,
  ollama: Ollama,
): Promise<ExerciseResult> {
  const start = Date.now();
  const scratch = await prepareMultiturnScratch(ex);
  let toolCallCount = 0;
  let turnsExecuted = 0;

  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content:
        'You are a coding agent in an iterative edit session. Each user turn builds on previous turns. ' +
        'Use the scoped tools (write_file, read_file, edit_file, list_files, shell) in the working directory. ' +
        'Preserve behavior of earlier turns unless the user explicitly asks you to change it. ' +
        'When each turn is complete, stop calling tools.',
    },
  ];

  try {
    for (const userMsg of ex.turns) {
      turnsExecuted++;
      messages.push({ role: 'user', content: userMsg });

      for (let t = 0; t < MAX_TURNS; t++) {
        const resp = await ollama.chat({
          model: modelName,
          messages: messages as never,
          tools: EXERCISE_TOOLS as never,
          stream: false,
          keep_alive: '30m',
          options: { num_predict: 2048, temperature: 0.1 },
        });
        const msg = resp.message;
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

        const calls = msg.tool_calls || [];
        if (calls.length === 0) break;

        for (const tc of calls) {
          toolCallCount++;
          const result = await execTool(
            scratch,
            tc.function.name,
            (tc.function.arguments || {}) as Record<string, unknown>,
          );
          messages.push({
            role: 'tool',
            content: result.length > 4000 ? result.slice(0, 4000) + '...[truncated]' : result,
          });
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: ex.name,
      pass: false,
      reason: `multiturn loop error at turn ${turnsExecuted}: ${msg}`,
      turns: turnsExecuted,
      durationMs: Date.now() - start,
      toolCallCount,
    };
  }

  const solutionPath = resolve(scratch, 'solution.ts');
  if (!existsSync(solutionPath)) {
    return {
      name: ex.name,
      pass: false,
      reason: 'no solution.ts after all turns',
      turns: turnsExecuted,
      durationMs: Date.now() - start,
      toolCallCount,
    };
  }

  const { pass, stderr } = await runVitest(scratch, ex.timeoutMs);
  if (pass) {
    try { await rm(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return {
    name: ex.name,
    pass,
    reason: pass ? `all turns + tests passed (${turnsExecuted} turns)` : 'final-state tests failed',
    turns: turnsExecuted,
    durationMs: Date.now() - start,
    toolCallCount,
    stderr: pass ? undefined : stderr,
  };
}

export async function runMultiturnSuite(
  modelName: string,
  ollama: Ollama,
  onProgress?: (ex: string, idx: number, total: number, result?: ExerciseResult) => void,
): Promise<ExerciseSuiteResult> {
  const exercises = await loadMultiturnExercises();
  const results: ExerciseResult[] = [];
  for (let i = 0; i < exercises.length; i++) {
    const ex = exercises[i];
    onProgress?.(ex.name, i + 1, exercises.length);
    const r = await runMultiturnExercise(ex, modelName, ollama);
    results.push(r);
    onProgress?.(ex.name, i + 1, exercises.length, r);
  }
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const score = total === 0 ? 0 : Math.round((passed / total) * 100);
  return { passed, total, score, results };
}

/** Cleanup stale scratch directories older than 24 hours. */
export async function cleanupScratch(): Promise<void> {
  if (!existsSync(SCRATCH_ROOT)) return;
  const now = Date.now();
  const entries = await readdir(SCRATCH_ROOT, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(SCRATCH_ROOT, e.name);
    try {
      const s = await stat(p);
      if (now - s.mtimeMs > 24 * 60 * 60 * 1000) {
        await rm(p, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }
}
