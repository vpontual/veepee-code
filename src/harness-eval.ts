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

import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

export interface ToolErrorGroup {
  tool: string;
  /** One representative message, trimmed. */
  error: string;
  count: number;
}

/**
 * Collapse an error message to its shape, so the same failure repeated with
 * different paths or line numbers groups into one entry instead of ten.
 */
export function errorSignature(msg: string): string {
  return msg
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/(['"`])(?:[^'"`\\]|\\.)*\1/g, 'X')     // quoted literals (paths, names)
    .replace(/\/[^\s:,)]+/g, 'PATH')                  // bare paths
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Group failing tool calls by tool and error shape, worst first. */
export function groupToolErrors(
  errors: Array<{ tool: string; error: string }>,
  limit = 5,
): ToolErrorGroup[] {
  const groups = new Map<string, ToolErrorGroup>();
  for (const e of errors) {
    const key = `${e.tool}\u0000${errorSignature(e.error)}`;
    const existing = groups.get(key);
    if (existing) { existing.count++; continue; }
    groups.set(key, { tool: e.tool, error: e.error.replace(/\s+/g, ' ').trim().slice(0, 200), count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

export interface HarnessTaskResult {
  task: string;
  /** True only if every run passed. With repeat=1 this is the single outcome. */
  passed: boolean;
  /**
   * How many times this task ran and how many of those passed.
   *
   * Single-sample scoring turned out to be unusable as a fitness function: the
   * same commit scored 50%, 100%, 100% on three consecutive runs. A gate that
   * asks "did the score move?" against that much variance accepts lucky
   * candidates and rejects unlucky ones with equal confidence.
   */
  runs: number;
  passes: number;
  /** Why it failed, when it did. */
  detail: string;
  tags: string[];
  /** Agent-loop metrics — the interesting part when comparing harnesses. */
  turns: number;
  toolCalls: number;
  /** Tool calls that failed. High numbers mean the harness is fighting itself. */
  toolErrors: number;
  /**
   * WHICH tools failed and how, grouped by error shape.
   *
   * The count alone is unactionable — "26% of tool calls failed" names no tool,
   * no argument and no message, so neither a human nor the improvement loop can
   * do anything with it. This is the part you can actually fix.
   *
   * Optional because runs saved before this existed do not have it, and typing
   * it as required would make every consumer trust a field that is absent from
   * most of the history.
   */
  toolErrorDetail?: ToolErrorGroup[];
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

/**
 * Make the scratch workspace a git repository.
 *
 * Without this, `git diff` — which the agent reaches for unprompted to check
 * its own work — returns `fatal: not a git repository` and exit 128. That is
 * recorded as a tool error and, on one run of extend-with-new-file, was enough
 * to lose the task. The failure was caused entirely by the eval: every real
 * project vcode works in is a git repo, so an eval without one measures the
 * agent's ability to cope with an environment it never actually meets.
 *
 * node_modules is excluded before the initial commit — it is a symlink to the
 * repo's, and committing it would put a bogus 120000 entry in every diff the
 * agent looks at.
 */
export function seedGitRepo(dir: string): void {
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: dir, stdio: 'ignore' });
    if (r.error) throw r.error;
  };
  try {
    git('init', '-q');
    git('config', 'user.email', 'eval@vcode.local');
    git('config', 'user.name', 'vcode eval');
    git('config', 'commit.gpgsign', 'false');
    // No trailing slash: `node_modules/` only matches a directory, and this is
    // a SYMLINK to one, which git treats as a file — so the slashed form let it
    // straight through into the initial commit.
    writeFileSync(join(dir, '.git', 'info', 'exclude'), 'node_modules\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'seed');
  } catch {
    // No git, or a git that refuses to run here. The agent simply sees what it
    // saw before this existed; nothing else in the eval depends on it.
  }
}

/**
 * Give a scratch checkout the repo's node_modules.
 *
 * Without it the task workspaces — whose `npm test` is `vitest run` — fail with
 * `vitest: command not found` on every single run. The agent then works around
 * it with `npx vitest`, which pulls a DIFFERENT vitest version off the network,
 * so the eval silently depended on registry access and graded with one version
 * what the agent ran with another. Symlinking is instant and offline.
 */
export function linkNodeModules(targetDir: string, repoRoot: string): void {
  const target = join(targetDir, 'node_modules');
  if (existsSync(target)) return;
  try {
    symlinkSync(join(repoRoot, 'node_modules'), target, 'dir');
  } catch { /* tests will fail loudly enough if this did not work */ }
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
/**
 * The agent an eval measures, wired exactly as the real CLI wires it.
 *
 * Shared by both instruments — the synthetic task suite and the commit-replay
 * runner — because an eval that registers a different toolset measures a
 * different harness, which makes its score worthless for the question being
 * asked. (An earlier version registered only two tool groups; the model
 * hallucinated a `syntax` tool, called it ten times and was stopped by loop
 * detection — a failure caused entirely by the eval.)
 *
 * MCP servers, remote-bridge tools and skills are deliberately excluded: they
 * depend on the machine and the network, so including them would make scores
 * incomparable across runs and across machines.
 */
export function buildEvalAgent(config: Config, modelManager: ModelManager, cwd: string): {
  agent: Agent;
  registry: ToolRegistry;
  permissions: PermissionManager;
  lspManager: LspManager;
} {
  const registry = new ToolRegistry();
  const ignoreManager = new IgnoreManager(cwd);
  const fileTracker = new FileTracker();
  const lspManager = new LspManager(config.lsp, cwd);

  const permissions = new PermissionManager();
  permissions.setPromptHandler(PermissionManager.unattendedHandler());
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

  return { agent, registry, permissions, lspManager };
}

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
    runs: 1,
    passes: 0,
    detail: '',
    tags: task.tags,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolErrorDetail: [],
    selfVerified: false,
    wallMs: 0,
    model,
  };

  const agentErrors: string[] = [];
  const failures: Array<{ tool: string; error: string }> = [];

  try {
    await cp(task.workspaceDir, scratch, { recursive: true });
    // The task's own `npm test` must work, or the eval measures the agent's
    // ability to cope with a broken workspace instead of its ability to code.
    linkNodeModules(scratch, prevCwd);
    // A real project is a git repo. Without this the agent's own `git diff`
    // self-check fails with exit 128 and the eval scores its own artifact.
    seedGitRepo(scratch);
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
    const built = buildEvalAgent(config, modelManager, scratch);
    const { agent, lspManager } = built;
    lspForTask = lspManager;

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
          if (ev.success === false) {
            result.toolErrors++;
            failures.push({ tool: ev.name ?? 'unknown', error: String(ev.error ?? ev.content ?? '') });
          }
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
    result.passes = result.passed ? 1 : 0;
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
    result.toolErrorDetail = groupToolErrors(failures);
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

/**
 * Fold N runs of one task into a single result.
 *
 * Metrics become means because a single run's tool-call count says as much
 * about which path the model happened to take as about the harness. `detail`
 * comes from the first failure, since that is the one worth reading.
 */
export function aggregateRuns(runs: HarnessTaskResult[]): HarnessTaskResult {
  const first = runs[0];
  const passes = runs.filter((r) => r.passes > 0).length;
  const mean = (pick: (r: HarnessTaskResult) => number) =>
    Math.round(runs.reduce((a, r) => a + pick(r), 0) / runs.length);
  const failed = runs.find((r) => r.passes === 0);
  return {
    ...first,
    passed: passes === runs.length,
    runs: runs.length,
    passes,
    detail: failed?.detail ?? '',
    turns: mean((r) => r.turns),
    toolCalls: mean((r) => r.toolCalls),
    toolErrors: mean((r) => r.toolErrors),
    // Merged across runs, so an intermittent tool failure is not lost just
    // because the run that hit it happened to pass.
    toolErrorDetail: groupToolErrors(
      runs.flatMap((r) => (r.toolErrorDetail ?? []).flatMap((g) =>
        Array.from({ length: g.count }, () => ({ tool: g.tool, error: g.error })))),
    ),
    // True only if it verified in EVERY run — the nudge either lands or it does not.
    selfVerified: runs.every((r) => r.selfVerified),
    wallMs: mean((r) => r.wallMs),
  };
}

export async function runHarnessSuite(
  config: Config,
  modelManager: ModelManager,
  opts: { only?: string; repeat?: number; resume?: boolean; checkpointDir?: string; onProgress?: (msg: string) => void } = {},
): Promise<HarnessEvalResult> {
  const all = await loadHarnessTasks();
  const only = opts.only;
  const tasks = only ? all.filter((t) => t.name === only || t.tags.includes(only)) : all;

  const repeat = Math.max(1, opts.repeat ?? 1);
  const commit = await currentCommit();
  const artifact = artifactHash();
  const key = `${commit}-r${repeat}${only ? `-${only.replace(/[^\w.-]/g, '_')}` : ''}`;

  // Resume: reuse only what was measured by THIS artifact. A checkpoint from a
  // different build is discarded loudly — mixing two builds into one score is
  // not a measurement of either.
  const results: HarnessTaskResult[] = [];
  const existing = await loadCheckpoint(key, opts.checkpointDir);
  if (existing) {
    if (!opts.resume) {
      opts.onProgress?.(`Found a partial run for ${key} (${existing.results.length} task(s) done) — pass --resume to continue it.`);
    } else if (existing.artifact !== artifact) {
      opts.onProgress?.(`Ignoring the partial run: it was measured on build ${existing.artifact}, this is ${artifact}.`);
    } else {
      results.push(...existing.results);
      opts.onProgress?.(`Resuming ${key}: ${results.length} task(s) already measured on this build.`);
    }
  }

  const checkpoint: EvalCheckpoint = {
    key, artifact, model: modelManager.getCurrentModel(), commit, repeat,
    ...(only ? { only } : {}),
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    results,
  };

  for (const [i, task] of tasks.entries()) {
    if (results.some((r) => r.task === task.name)) {
      opts.onProgress?.(`[${i + 1}/${tasks.length}] ${task.name}: reusing checkpointed result`);
      continue;
    }
    const attempts: HarnessTaskResult[] = [];
    for (let n = 1; n <= repeat; n++) {
      opts.onProgress?.(`[${i + 1}/${tasks.length}] ${task.name}${repeat > 1 ? ` (run ${n}/${repeat})` : ''} …`);
      attempts.push(await runHarnessTask(task, config, modelManager));
    }
    const r = aggregateRuns(attempts);
    results.push(r);
    // Checkpoint after EVERY task. A crash now costs the task in flight, not
    // the whole suite.
    checkpoint.results = results;
    await writeCheckpoint(checkpoint, opts.checkpointDir).catch(() => {});
    opts.onProgress?.(
      `[${i + 1}/${tasks.length}] ${task.name}: ${r.passes}/${r.runs} passed ` +
      `(${Math.round(r.wallMs / 1000)}s avg, ${r.toolCalls} tool calls${r.selfVerified ? ', self-verified' : ''})`,
    );
  }

  // Score is the pass RATE across every run, not the count of tasks that
  // passed every time — a task that passes 2 of 3 is real information.
  const totalRuns = results.reduce((a, r) => a + r.runs, 0);
  const totalPasses = results.reduce((a, r) => a + r.passes, 0);
  const passed = results.filter((r) => r.passed).length;
  // The suite completed: the partial is now redundant, and leaving it behind
  // would offer a resume of a finished run.
  await rm(checkpointPath(key, opts.checkpointDir), { force: true }).catch(() => {});
  return {
    at: new Date().toISOString(),
    model: modelManager.getCurrentModel(),
    commit,
    passed,
    total: results.length,
    score: totalRuns > 0 ? Math.round((totalPasses / totalRuns) * 100) : 0,
    results,
  };
}

/**
 * Per-task checkpointing.
 *
 * The suite used to write nothing until all 15 tasks finished, so a process
 * death at task 7 destroyed six completed tasks — thirty model runs and ~25
 * minutes — with no trace. That happened (2026-08-23) and the results survived
 * only because someone was tailing the log.
 *
 * The checkpoint is keyed by the ARTIFACT, not just the commit: a resumed run
 * that mixes results from two builds is not a measurement, it is an average of
 * two different programs. A build hash mismatch refuses the resume and says so,
 * rather than quietly producing a number nobody can attribute.
 */
export interface EvalCheckpoint {
  key: string;
  artifact: string;
  model: string;
  commit: string;
  repeat: number;
  only?: string;
  startedAt: string;
  results: HarnessTaskResult[];
}

/** Identity of the built artifact under test — content, not timestamp. */
export function artifactHash(): string {
  const dist = resolve(process.cwd(), 'dist', 'index.js');
  if (!existsSync(dist)) return 'no-dist';
  try {
    return createHash('sha256').update(readFileSync(dist)).digest('hex').slice(0, 12);
  } catch {
    return 'unreadable';
  }
}

export function checkpointPath(key: string, dir?: string): string {
  const outDir = dir ?? resolve(process.env.HOME || '~', '.veepee-code', 'harness-evals');
  return join(outDir, `.partial-${key}.json`);
}

export async function loadCheckpoint(key: string, dir?: string): Promise<EvalCheckpoint | null> {
  const path = checkpointPath(key, dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as EvalCheckpoint;
  } catch {
    return null;
  }
}

async function writeCheckpoint(cp: EvalCheckpoint, dir?: string): Promise<void> {
  const path = checkpointPath(cp.key, dir);
  await mkdir(resolve(path, '..'), { recursive: true });
  // Write-then-rename: a crash mid-write must not leave a half-parsed
  // checkpoint that then refuses to resume.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(cp, null, 2));
  await rename(tmp, path);
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
