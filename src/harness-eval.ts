/**
 * Harness evaluation — measure vcode itself, not the model.
 *
 * `benchmark.ts` scores MODELS: it drives `ollama.chat` with a hand-rolled loop
 * and asks "can this model write a debounce function". That answers a question
 * about the model, not about vcode.
 *
 * The harness — context management, tool design, permission flow, the
 * force-act and force-verify nudges, compaction thresholds, effort budgets — is
 * at least as large a lever on real coding performance, and nothing measured
 * it. Every change to the agent loop was an unfalsifiable guess: it felt
 * better, or it didn't.
 *
 * So this runs the REAL Agent, with the REAL ToolRegistry, against tasks that
 * only pass if the agent reads existing files, edits several of them, runs the
 * project's tests, and fixes what it broke. Then it checks the result with the
 * task's own test suite, which the agent never sees.
 *
 * Results are written as JSON so two runs are comparable — which is the whole
 * point. "Did this harness change help?" becomes a diff, not an opinion.
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Config } from './config.js';
import { Agent } from './agent.js';
import { ToolRegistry } from './tools/registry.js';
import { ModelManager } from './models.js';
import { PermissionManager } from './permissions.js';
import { registerCodingTools } from './tools/coding.js';
import { registerDevOpsTools } from './tools/devops.js';
import { registerWebTools } from './tools/web.js';
import { registerLspTools } from './tools/lsp.js';
import { createTaskTool } from './tools/task.js';
import { createExitPlanModeTool } from './tools/plan-gate.js';
import { createNotebookEditTool } from './tools/notebook.js';
import { buildAskUserTool } from './tools/interaction.js';
import { buildDeepResearchTool } from './deep-research.js';
import { LspManager } from './lsp/manager.js';
import { IgnoreManager } from './ignore.js';
import { FileTracker } from './filetracker.js';

const TASKS_DIR = resolve(process.cwd(), 'benchmarks', 'harness');
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface HarnessTask {
  name: string;
  /** The instruction handed to the agent, verbatim. */
  prompt: string;
  /** Directory whose contents seed the scratch workspace. */
  workspaceDir: string;
  /** Test file copied in AFTER the agent finishes, then run to grade it. */
  verifyPath: string;
  /** What this task is designed to stress, for reporting. */
  tags: string[];
  timeoutMs: number;
  dir: string;
}

export interface HarnessTaskResult {
  task: string;
  passed: boolean;
  /** Why it failed, when it did. */
  detail: string;
  tags: string[];
  /** Agent-loop metrics — the interesting part when comparing harnesses. */
  turns: number;
  toolCalls: number;
  /** Tool calls that failed. High numbers mean the harness is fighting itself. */
  toolErrors: number;
  /** Did the agent run the tests itself, unprompted? The force-verify nudge
   *  exists to make this true; this is how we find out whether it works. */
  selfVerified: boolean;
  wallMs: number;
  model: string;
}

export interface HarnessEvalResult {
  at: string;
  model: string;
  /** Commit the harness was at, so results can be attributed to a change. */
  commit: string;
  passed: number;
  total: number;
  score: number;
  results: HarnessTaskResult[];
}

/** Load every task in benchmarks/harness/. */
export async function loadHarnessTasks(dir: string = TASKS_DIR): Promise<HarnessTask[]> {
  if (!existsSync(dir)) return [];
  const out: HarnessTask[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskDir = resolve(dir, entry.name);
    const promptPath = join(taskDir, 'task.md');
    const workspaceDir = join(taskDir, 'workspace');
    const verifyPath = join(taskDir, 'verify.test.ts');
    if (!existsSync(promptPath) || !existsSync(workspaceDir) || !existsSync(verifyPath)) continue;

    let tags: string[] = [];
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    const metaPath = join(taskDir, 'metadata.json');
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as { tags?: string[]; timeout_ms?: number };
        tags = meta.tags ?? [];
        if (typeof meta.timeout_ms === 'number') timeoutMs = meta.timeout_ms;
      } catch { /* defaults */ }
    }

    out.push({
      name: entry.name,
      prompt: (await readFile(promptPath, 'utf-8')).trim(),
      workspaceDir,
      verifyPath,
      tags,
      timeoutMs,
      dir: taskDir,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Run a command in the scratch workspace, bounded and group-killed. */
function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolveP) => {
    // NO_COLOR because this output is stored in the result JSON and later fed
    // to a model as evidence — ANSI escapes there are noise in the prompt and
    // gibberish in a report.
    const proc = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let out = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      resolveP({ code, out });
    };
    const timer = setTimeout(() => {
      try { if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
      out += `\n[timed out after ${timeoutMs}ms]`;
      finish(124);
    }, timeoutMs);
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', (code) => finish(code ?? 1));
    proc.on('error', (err) => { out += String(err.message); finish(1); });
  });
}

/**
 * Run one task end to end.
 *
 * The agent gets the same tools it has in normal use, rooted at a throwaway
 * copy of the task workspace. Permissions are auto-allowed because there is no
 * human to prompt — which is also why this must only ever run against a scratch
 * directory.
 */
export async function runHarnessTask(
  task: HarnessTask,
  config: Config,
  modelManager: ModelManager,
): Promise<HarnessTaskResult> {
  const started = Date.now();
  const model = modelManager.getCurrentModel();
  const scratch = await mkdtemp(join(tmpdir(), `vcode-eval-${task.name}-`));
  const prevCwd = process.cwd();
  let gradeDir: string | null = null;
  let lspForTask: LspManager | null = null;

  const result: HarnessTaskResult = {
    task: task.name,
    passed: false,
    detail: '',
    tags: task.tags,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    selfVerified: false,
    wallMs: 0,
    model,
  };

  const agentErrors: string[] = [];

  try {
    await cp(task.workspaceDir, scratch, { recursive: true });
    // The tools resolve paths against process.cwd(), so the eval runs one task
    // at a time from inside the scratch directory. Sequential by design.
    process.chdir(scratch);

    // Register the SAME toolset the real CLI does.
    //
    // An earlier version registered only the coding and devops groups, and the
    // model promptly hallucinated a `syntax` tool, called it ten times, and was
    // stopped by loop detection — a failure caused entirely by the eval, not by
    // the harness. An eval that runs a different toolset measures a different
    // harness, which makes its score worthless for the question being asked.
    //
    // MCP servers, remote-bridge tools and skills are deliberately NOT included:
    // they depend on the machine and network, so including them would make
    // scores incomparable across runs.
    const registry = new ToolRegistry();
    const ignoreManager = new IgnoreManager(scratch);
    const fileTracker = new FileTracker();
    const lspManager = new LspManager(config.lsp, scratch);
    lspForTask = lspManager;

    const permissions = new PermissionManager();
    permissions.setPromptHandler(async () => 'y');
    const agent = new Agent(config, registry, modelManager, permissions);

    for (const tool of registerCodingTools(ignoreManager, fileTracker, lspManager)) registry.register(tool);
    for (const tool of registerWebTools(config)) registry.register(tool);
    registry.register(buildDeepResearchTool(config));
    registry.register(buildAskUserTool());
    for (const tool of registerDevOpsTools()) registry.register(tool);
    for (const tool of registerLspTools(lspManager)) registry.register(tool);
    registry.register(createTaskTool(agent.getSubAgents()));
    registry.register(createExitPlanModeTool(agent, permissions));
    registry.register(createNotebookEditTool(ignoreManager, fileTracker));

    const deadline = setTimeout(() => agent.abort(), task.timeoutMs);
    try {
      for await (const ev of agent.run(task.prompt, { permissionMode: 'auto_allow' })) {
        if (ev.type === 'tool_call') {
          result.toolCalls++;
          // Running the test suite without being told to is the behaviour the
          // force-verify nudge is supposed to produce.
          if (ev.name === 'bash') {
            const cmd = String((ev.args as { command?: string })?.command ?? '');
            if (/\b(npm|npx|vitest|pnpm|yarn)\b.*\b(test|vitest)\b|tsc\b/.test(cmd)) {
              result.selfVerified = true;
            }
          }
        } else if (ev.type === 'tool_result') {
          if (ev.success === false) result.toolErrors++;
        } else if (ev.type === 'done') {
          result.turns++;
        } else if (ev.type === 'error') {
          // Agent-level failures (model unreachable, stuck-loop abort, context
          // rejected) must surface. Without this a run that never called a
          // tool looked identical to one that tried and failed the grader.
          agentErrors.push(String(ev.error ?? ev.content ?? 'unknown'));
        }
      }
    } finally {
      clearTimeout(deadline);
    }

    // Grade it.
    //
    // Grading runs in a throwaway directory INSIDE this repo, not in /tmp.
    // vitest's config imports 'vitest/config', which Node resolves by walking
    // up from the config file — from /tmp that finds nothing and vitest dies
    // with ERR_MODULE_NOT_FOUND before running a single assertion. That failure
    // is indistinguishable from a real one at the exit-code level, so grading
    // silently depended on whether the agent had happened to run `npm install`
    // in its scratch directory. Placing the grading copy under the repo makes
    // node_modules resolve normally and the result deterministic.
    //
    // The AGENT still works in /tmp — it never sees this directory, and the
    // verification test is only introduced here, so it can be neither read nor
    // edited to make itself pass.
    gradeDir = join(prevCwd, `.eval-grade-${process.pid}-${Date.now().toString(36)}`);
    await cp(scratch, gradeDir, { recursive: true });
    await cp(task.verifyPath, join(gradeDir, 'verify.test.ts'));
    await writeFile(
      join(gradeDir, 'vitest.config.mjs'),
      "import { defineConfig } from 'vitest/config';\n" +
      "export default defineConfig({ test: { include: ['verify.test.ts'], testTimeout: 20000 } });\n",
    );
    const vitestBin = resolve(prevCwd, 'node_modules', '.bin', 'vitest');
    const graded = await run(vitestBin, ['run'], gradeDir, 120_000);
    result.passed = graded.code === 0;
    if (!result.passed) {
      // Lead with agent errors when there are any: "the model was unreachable"
      // and "the model wrote the wrong code" are completely different results
      // and must not read the same in a report.
      result.detail = agentErrors.length > 0
        ? `agent error: ${agentErrors.slice(0, 3).join(' | ')}`
        : graded.out.split('\n').filter(Boolean).slice(-12).join('\n');
    }
  } catch (err) {
    result.detail = err instanceof Error ? err.message : String(err);
  } finally {
    process.chdir(prevCwd);
    result.wallMs = Date.now() - started;
    await lspForTask?.shutdown().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    if (gradeDir) await rm(gradeDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}

/** Current harness commit, so a result can be attributed to a change. */
async function currentCommit(): Promise<string> {
  const r = await run('git', ['rev-parse', '--short', 'HEAD'], process.cwd(), 5000);
  return r.code === 0 ? r.out.trim() : 'unknown';
}

export async function runHarnessSuite(
  config: Config,
  modelManager: ModelManager,
  opts: { only?: string; onProgress?: (msg: string) => void } = {},
): Promise<HarnessEvalResult> {
  const all = await loadHarnessTasks();
  const only = opts.only;
  const tasks = only ? all.filter((t) => t.name === only || t.tags.includes(only)) : all;

  const results: HarnessTaskResult[] = [];
  for (const [i, task] of tasks.entries()) {
    opts.onProgress?.(`[${i + 1}/${tasks.length}] ${task.name} …`);
    const r = await runHarnessTask(task, config, modelManager);
    results.push(r);
    opts.onProgress?.(
      `[${i + 1}/${tasks.length}] ${task.name}: ${r.passed ? 'PASS' : 'FAIL'} ` +
      `(${Math.round(r.wallMs / 1000)}s, ${r.toolCalls} tool calls${r.selfVerified ? ', self-verified' : ''})`,
    );
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    at: new Date().toISOString(),
    model: modelManager.getCurrentModel(),
    commit: await currentCommit(),
    passed,
    total: results.length,
    score: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
    results,
  };
}

/** Persist a run so successive runs can be compared. */
export async function saveEvalResult(result: HarnessEvalResult, dir?: string): Promise<string> {
  const outDir = dir ?? resolve(process.env.HOME || '~', '.veepee-code', 'harness-evals');
  await mkdir(outDir, { recursive: true });
  const stamp = result.at.replace(/[:.]/g, '-');
  const path = join(outDir, `${stamp}-${result.commit}.json`);
  await writeFile(path, JSON.stringify(result, null, 2));
  return path;
}

/** Human-readable comparison against a previous run. */
export function compareRuns(prev: HarnessEvalResult, next: HarnessEvalResult): string {
  const lines: string[] = [
    `${prev.commit} → ${next.commit}:  ${prev.score}% → ${next.score}%  (${prev.passed}/${prev.total} → ${next.passed}/${next.total})`,
  ];
  const prevByTask = new Map(prev.results.map((r) => [r.task, r]));
  for (const r of next.results) {
    const before = prevByTask.get(r.task);
    if (!before) { lines.push(`  + ${r.task}: ${r.passed ? 'PASS' : 'FAIL'} (new)`); continue; }
    if (before.passed !== r.passed) {
      lines.push(`  ${r.passed ? '✓ FIXED  ' : '✗ BROKE  '} ${r.task}`);
    }
  }
  return lines.join('\n');
}
