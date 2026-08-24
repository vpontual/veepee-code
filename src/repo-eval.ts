/**
 * Commit-replay evaluation against REAL repositories.
 *
 * The 15-task `benchmarks/harness/` suite measures a harness on small, mostly
 * single-file, purpose-built problems. That is a useful instrument and it is not
 * the goal. The goal is: **does vcode edit VP's real repos as well as Claude
 * Code does** — repos of real size, real structure, real test suites, and
 * changes a person actually made. Nothing in the small suite exercises a
 * multi-file cascade, an unfamiliar codebase, or a session long enough for
 * compaction to fire, which is exactly where the harness earns or loses.
 *
 * The method is replay, because it needs no hand-written grader and cannot be
 * gamed by a task author (me) who already knows the fix:
 *
 *   1. take a real commit that changed BOTH source and tests;
 *   2. check the repo out at the commit's PARENT, in a throwaway clone;
 *   3. restore only the commit's TEST files, so the grading tests exist and the
 *      implementation does not;
 *   4. confirm the suite FAILS — a task whose tests already pass measures
 *      nothing, and this is the check that stops a silently-vacuous task from
 *      inflating the score;
 *   5. hand the agent the commit message as the instruction;
 *   6. grade by running the repo's own test suite.
 *
 * The commit message is the fair prompt: it is what a person was told, or told
 * themselves, before making the change. The diff is never shown.
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config } from './config.js';
import type { ModelManager } from './models.js';
import { buildEvalAgent } from './harness-eval.js';

export interface RepoTask {
  /** Short label, e.g. `socialfeed@b65d5b2`. */
  name: string;
  repoPath: string;
  sha: string;
  /** The commit message — subject and body, no diff. */
  prompt: string;
  testFiles: string[];
  srcFiles: string[];
  /** Command that runs the repo's own suite. */
  testCommand: string;
  timeoutMs: number;
  /**
   * Whether the agent may SEE the tests it will be graded by.
   *
   * `spec` restores the commit's test files before the agent runs: the
   * assertions are in the working tree, so the task is spec-complete and the
   * agent's job is to satisfy a known oracle.
   *
   * `blind` restores them only at grading time. The agent gets the commit
   * message and nothing else, and has to decide what "done" means from an
   * intent-shaped instruction — which is the actual job. Strictly harder, and
   * the honest one. The gap between the two modes is itself a measurement:
   * it prices how much of the agent's success comes from being handed the
   * answer key.
   */
  mode: 'spec' | 'blind';
}

/**
 * Why a task failed — and the rule that makes the number honest.
 *
 * `model`   the model produced wrong or incomplete content, with the harness
 *           doing its job: it read what it asked for, its edits applied, its
 *           commands ran and reported truthfully.
 * `harness` vcode lost, truncated, mis-parsed, mis-routed or dropped something —
 *           a failed edit application, a swallowed error, a context loss, a
 *           guard that fired when it should not have.
 * `budget`  the run was STOPPED by a limit we imposed — turn cap, wall-clock
 *           deadline, stuck-loop guard. Its own class because a limit reported
 *           as an inability is the same mistake as an unknown reported as a
 *           fact, with the sign inverted: the agent did not fail to do the work,
 *           it was not allowed to finish. Counting these as model failures would
 *           launder harness decisions into evidence about the model.
 * `infrastructure` the inference endpoint was unreachable — the engine was
 *           down or restarting. Out of scope by VP's rule (vLLM and DGX
 *           behaviour are not mine), and it must not be counted as harness
 *           either: an eval run that loses tasks to a wedged engine is measuring
 *           the fleet, not the agent. What IS mine is waiting long enough for
 *           the watchdog to bring it back — see `retry.ts`.
 * `grader`  the task or the grading is wrong (this happened tonight: a task
 *           scored 0/5 on work that was correct).
 * `alternative-impl` (blind mode only) the repo's PRE-EXISTING suite passes and
 *           only the commit's own restored tests fail. The agent may have built
 *           a defensible different thing that this particular oracle does not
 *           accept — a grader artifact wearing a model-failure costume. Counted
 *           separately and never merged into either, because letting it through
 *           would make blind mode look like a harness regression when it is an
 *           oracle mismatch.
 * `unclassified` counts as HARNESS until proven otherwise.
 *
 * THE BURDEN OF PROOF SITS ON `model`, NOT ON `harness`.
 *
 * "Model" was the residual bucket — whatever was left when nothing else
 * explained the failure. That default is backwards, and it would quietly absorb
 * the exact bugs that are hardest to see: a harness that corrupts CONTENT while
 * reporting success presents as model stupidity every single time. Truncated
 * tool output the model believes is complete; a compaction that dropped the
 * detail it then invents around; an edit applied to a plausible-but-wrong
 * region; a stale version of a file served after a newer one. Every one of those
 * looks like "the model did something dumb".
 *
 * So a `model` verdict now requires POSITIVE EVIDENCE: the run's captured
 * transcript — tool calls, results, and the diff actually applied — must exist,
 * so that a human can check the inputs were correct and complete. No transcript,
 * no `model`; it falls back to `unclassified`, which counts as harness. VP's bar is that the
 *           residual gap be attributable to model size alone; an unexplained
 *           failure is not evidence for that, it is evidence against it.
 */
export type FailureClass = 'model' | 'harness' | 'budget' | 'infrastructure' | 'grader' | 'alternative-impl' | 'unclassified';

export interface RepoTaskResult {
  task: string;
  mode: 'spec' | 'blind';
  passed: boolean;
  /** Set on failure. Absent when the task passed. */
  failure?: FailureClass;
  /** Evidence for the classification — never a bare label. */
  failureEvidence?: string;
  /** What the agent actually changed, kept on failure so a wrong-location edit
   *  can be caught by inspection rather than assumed absent. */
  appliedDiff?: string;
  /** Path to the captured transcript. A `model` verdict is not available
   *  without one — see FailureClass. */
  evidencePath?: string;
  /** The suite failed before the agent ran, as a valid task requires. */
  startedFailing: boolean;
  /** Blind mode: did the repo's own pre-existing tests pass after the agent's work? */
  preExistingSuitePassed?: boolean;
  toolCalls: number;
  toolErrors: number;
  /** Assistant turns consumed — a first-class metric, not a log artifact. */
  turns: number;
  wallMs: number;
  selfVerified: boolean;
  detail?: string;
}

/** Test-file heuristics, matched against the repo layouts actually in use. */
const TEST_PATH = /(^|\/)(test|tests|spec|__tests__)\//;
const TEST_NAME = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py)$|(^|\/)test_[^/]+\.py$|_test\.py$/;

export function isTestFile(path: string): boolean {
  return TEST_PATH.test(path) || TEST_NAME.test(path);
}

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.trim() || r.status}`);
  return r.stdout;
}

/**
 * The command that runs this repo's suite.
 *
 * Deliberately conservative: a repo whose test command cannot be identified is
 * skipped rather than guessed at, because a wrong command fails every task
 * identically and would read as "the agent cannot code".
 */
export async function detectTestCommand(repoPath: string): Promise<string | null> {
  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
      const test = pkg.scripts?.test;
      // `next lint`-style placeholders and "no test specified" stubs are not suites.
      if (test && !/no test specified|echo /.test(test)) return 'npm test --silent';
    } catch { /* fall through */ }
  }
  if (existsSync(join(repoPath, 'pytest.ini')) || existsSync(join(repoPath, 'pyproject.toml'))) {
    return 'python -m pytest -q';
  }
  return null;
}

/**
 * Turn a commit into a task, or explain why it cannot be one.
 */
export async function taskFromCommit(
  repoPath: string,
  sha: string,
  timeoutMs = 900_000,
  mode: 'spec' | 'blind' = 'blind',
): Promise<RepoTask | string> {
  const files = git(repoPath, ['show', '--name-only', '--format=', sha]).split('\n').filter(Boolean);
  if (files.length === 0) return 'no files changed';
  const testFiles = files.filter(isTestFile);
  const srcFiles = files.filter((f) => !isTestFile(f));
  if (testFiles.length === 0) return 'no test files — nothing could grade it';
  if (srcFiles.length === 0) return 'test-only commit — nothing for the agent to implement';
  if (files.length > 15) return `too large (${files.length} files)`;

  const testCommand = await detectTestCommand(repoPath);
  if (!testCommand) return 'no test command detected';

  const subject = git(repoPath, ['log', '-1', '--format=%s', sha]).trim();
  // A commit message is the whole specification here. "fix bug" is not one, and
  // failing it measures nothing. The messages are NEVER rewritten — that would
  // make me the spec author, which is how the synthetic suite got a task wrong
  // tonight. Thin ones are dropped, and the drop count is itself a finding.
  if (subject.length < 25 || /^(wip|fix|update|cleanup|tweak|misc)\b[.:]?$/i.test(subject)) {
    return `commit message too thin to be a specification: "${subject}"`;
  }
  const body = git(repoPath, ['log', '-1', '--format=%b', sha]).trim();
  // Strip trailers — they say who wrote it, not what to do.
  const cleanBody = body
    .split('\n')
    .filter((l) => !/^(Co-Authored-By|Claude-Session|Signed-off-by):/i.test(l))
    .join('\n')
    .trim();

  return {
    name: `${repoPath.split('/').pop()}@${sha.slice(0, 7)}`,
    repoPath,
    sha,
    prompt: [
      subject,
      cleanBody,
      '',
      mode === 'spec'
        ? 'The tests for this change are already written and currently failing. Implement it so they pass, then run the suite.'
        : 'Implement this. Verify your work however you think is appropriate before finishing.',
    ].filter(Boolean).join('\n\n'),
    testFiles,
    srcFiles,
    testCommand,
    timeoutMs,
    mode,
  };
}

/**
 * Build the scratch working tree: the parent commit, plus this commit's tests.
 *
 * A LOCAL clone (`--shared`) rather than a copy — instant, and it cannot write
 * to the source repo's working tree. `node_modules` is symlinked instead of
 * installed: an `npm install` per task would dominate the runtime and measure
 * the network rather than the harness.
 */
export async function prepareRepoWorkspace(task: RepoTask): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vcode-repoeval-'));
  const work = join(dir, 'repo');
  const r = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', task.repoPath, work], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  git(work, ['checkout', '--quiet', `${task.sha}^`]);
  // `spec`: the grader exists in the tree and the implementation does not.
  // `blind`: nothing is restored — the agent never sees what it is judged by.
  if (task.mode === 'spec') {
    git(work, ['checkout', task.sha, '--', ...task.testFiles]);
  }

  const nm = join(task.repoPath, 'node_modules');
  if (existsSync(nm) && !existsSync(join(work, 'node_modules'))) {
    try { symlinkSync(nm, join(work, 'node_modules'), 'dir'); } catch { /* optional */ }
  }
  return work;
}

/**
 * Undo `restoreGradingTests`: put the parent's version of each test file back,
 * deleting the ones that did not exist yet.
 *
 * Needed because a blind task must still be VALIDATED with its oracle — run the
 * commit's tests at the parent and confirm they fail — and then the oracle has
 * to disappear again before the agent starts. Skipping the validation would let
 * a task whose tests already pass count as a success for doing nothing, which is
 * the vacuous-task trap one level deeper than the one the synthetic suite hit.
 */
export function hideGradingTests(work: string, task: RepoTask): void {
  for (const f of task.testFiles) {
    const existedAtParent = spawnSync('git', ['cat-file', '-e', `HEAD:${f}`], { cwd: work }).status === 0;
    if (existedAtParent) git(work, ['checkout', 'HEAD', '--', f]);
    else spawnSync('rm', ['-f', join(work, f)]);
  }
}

/**
 * Put the commit's tests in place for grading.
 *
 * In `blind` mode this is the first time they touch the working tree, so the
 * agent could not have read, edited or deleted them — which also closes the
 * cheapest way to pass an eval: changing the test.
 */
export function restoreGradingTests(work: string, task: RepoTask): void {
  git(work, ['checkout', task.sha, '--', ...task.testFiles]);
}

/** Run the repo's own suite. Returns pass/fail plus the tail of the output. */
export function runSuite(work: string, command: string, timeoutMs = 600_000): { passed: boolean; output: string } {
  const r = spawnSync('bash', ['-lc', command], {
    cwd: work, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  return { passed: r.status === 0, output: output.slice(-4_000) };
}

/** Discard a prepared workspace. */
export async function cleanupWorkspace(work: string): Promise<void> {
  await rm(resolve(work, '..'), { recursive: true, force: true }).catch(() => {});
}

/** Persist a suite result beside the harness-eval ones. */
export async function saveRepoEvalResult(results: RepoTaskResult[], dir?: string): Promise<string> {
  const outDir = dir ?? resolve(process.env.HOME || '~', '.veepee-code', 'repo-evals');
  await mkdir(outDir, { recursive: true });
  const at = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(outDir, `${at}.json`);
  await writeFile(path, JSON.stringify({ at, results }, null, 2));
  return path;
}

/**
 * Run one commit-replay task end to end.
 *
 * The agent works in the throwaway clone and never sees the real repository.
 * Grading runs the repo's OWN suite — the same command a person would run — so
 * there is no hand-written grader to get wrong, which is the failure mode that
 * cost the synthetic suite a task earlier tonight.
 */
export async function runRepoTask(
  task: RepoTask,
  config: Config,
  modelManager: ModelManager,
): Promise<RepoTaskResult> {
  const started = Date.now();
  const prevCwd = process.cwd();
  const result: RepoTaskResult = {
    task: task.name, mode: task.mode, passed: false, startedFailing: false,
    toolCalls: 0, toolErrors: 0, turns: 0, wallMs: 0, selfVerified: false,
  };
  const agentErrors: string[] = [];
  const toolFailures: string[] = [];
  /** Everything the model saw and did, kept so a class-(a) verdict can be checked. */
  const transcript: Array<Record<string, unknown>> = [];

  let work = '';
  try {
    work = await prepareRepoWorkspace(task);

    // A task whose tests already pass measures nothing. In `spec` mode the
    // tests are already in the tree; in `blind` mode they must be brought in for
    // the check and then hidden again, because the validation matters more than
    // the inconvenience — without it a vacuous task scores a free pass.
    if (task.mode === 'blind') restoreGradingTests(work, task);
    const before = runSuite(work, task.testCommand);
    result.startedFailing = !before.passed;
    if (task.mode === 'blind') hideGradingTests(work, task);
    if (before.passed) {
      result.detail = 'the commit\'s own tests already pass at its parent — not a task';
      result.failure = 'grader';
      result.failureEvidence = 'vacuous task: nothing for the agent to make true';
      return result;
    }

    process.chdir(work);
    const { agent } = buildEvalAgent(config, modelManager, work);
    // Ladder, not a guillotine. The deadline itself is a PROVEN state so
    // terminating on it is legitimate — but a task killed mid-edit with a
    // 276-line diff in the tree had five more minutes of useful work available
    // to it, and no way to know. Warn first so it can land what it has.
    const warning = setTimeout(
      () => agent.notify(
        '[SYSTEM] About five minutes of wall-clock budget remain for this task. '
        + 'Finish and verify what you already have rather than starting anything new; '
        + 'partial work that runs beats complete work that gets cut off.',
      ),
      Math.max(0, task.timeoutMs - 300_000),
    );
    const deadline = setTimeout(() => agent.abort(), task.timeoutMs);
    try {
      for await (const ev of agent.run(task.prompt, { permissionMode: 'auto_allow' })) {
        if (ev.type === 'tool_call') {
          result.toolCalls++;
          transcript.push({ kind: 'tool_call', name: ev.name, args: ev.args });
          if (ev.name === 'bash') {
            const cmd = String((ev.args as { command?: string })?.command ?? '');
            if (/\b(npm|npx|vitest|pnpm|yarn|pytest|python)\b.*\b(test|vitest|pytest)\b/.test(cmd)) {
              result.selfVerified = true;
            }
          }
        } else if (ev.type === 'tool_result') {
          transcript.push({
            kind: 'tool_result', name: ev.name, success: ev.success,
            content: String(ev.content ?? ev.error ?? '').slice(0, 4_000),
          });
        }
        if (ev.type === 'text' && ev.content) {
          transcript.push({ kind: 'assistant_text', content: String(ev.content).slice(0, 4_000) });
        }
        if (ev.type === 'tool_result' && ev.success === false) {
          result.toolErrors++;
          if (toolFailures.length < 12) {
            toolFailures.push(`${ev.name ?? 'tool'}: ${String(ev.error ?? ev.content ?? '').slice(0, 200)}`);
          }
        } else if (ev.type === 'done') {
          result.turns++;
        } else if (ev.type === 'error') {
          // Agent-level failure — stuck-loop abort, turn cap, model unreachable,
          // context rejected. These are harness events by definition and must
          // never be quietly folded into "the model got it wrong".
          agentErrors.push(String(ev.error ?? ev.content ?? 'unknown'));
        }
      }
    } finally {
      clearTimeout(warning);
      clearTimeout(deadline);
    }

    process.chdir(prevCwd);
    // In blind mode, first ask the question that separates "wrong" from
    // "different": does the repo's OWN suite — the tests that existed before
    // this commit — still pass? If it does and only the commit's tests fail,
    // the agent may have built a defensible alternative rather than a mistake.
    if (task.mode === 'blind') {
      result.preExistingSuitePassed = runSuite(work, task.testCommand).passed;
      // The grading tests arrive only now: the agent never had them, so it
      // cannot have passed by editing them.
      restoreGradingTests(work, task);
    }
    const after = runSuite(work, task.testCommand);
    result.passed = after.passed;
    if (!after.passed) {
      result.detail = after.output.slice(-1_500);
      // Keep what the agent actually DID on a failure. The dangerous harness
      // bug is the quiet one: an edit applied to a plausible-but-wrong region
      // produces working-looking code that fails the tests, which is
      // indistinguishable from the model writing the wrong thing. A diff can be
      // inspected; an assumption that it did not happen cannot.
      const diff = spawnSync('git', ['diff', '--stat', 'HEAD', '--', '.'], {
        cwd: work, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024,
      });
      result.appliedDiff = (diff.stdout ?? '').slice(0, 2_000);
      const fullDiff = spawnSync('git', ['diff', 'HEAD', '--', '.'], {
        cwd: work, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024,
      });
      result.evidencePath = await saveEvidence(task, {
        prompt: task.prompt,
        transcript,
        appliedDiff: (fullDiff.stdout ?? '').slice(0, 200_000),
        suiteOutput: after.output,
        agentErrors,
      });
      const cls = classifyFailure({
        agentErrors, toolFailures, suiteOutput: after.output,
        preExistingSuitePassed: result.preExistingSuitePassed,
        hasEvidence: Boolean(result.evidencePath),
      });
      result.failure = cls.failure;
      result.failureEvidence = cls.evidence;
    }
  } catch (err) {
    result.detail = `harness error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    process.chdir(prevCwd);
    if (work) await cleanupWorkspace(work);
    result.wallMs = Date.now() - started;
  }
  return result;
}

/**
 * First-pass failure classification, from evidence the run already produced.
 *
 * Deliberately conservative in one direction: it will call something HARNESS on
 * thin evidence and will never call something MODEL on thin evidence. The bar
 * VP set is that the residual gap be attributable to model size alone, and a
 * classifier that resolves its own uncertainty in favour of "the model did it"
 * would manufacture exactly that conclusion.
 *
 * Anything it cannot place is `unclassified`, which counts as harness until a
 * human looks at it.
 */
export function classifyFailure(ev: {
  agentErrors: string[];
  toolFailures: string[];
  suiteOutput: string;
  preExistingSuitePassed?: boolean;
  /** Was a transcript captured? Without one, `model` is not available. */
  hasEvidence?: boolean;
}): { failure: FailureClass; evidence: string } {
  // The engine was absent. Neither the model's fault nor the harness's.
  const unreachable = ev.agentErrors.find((e) =>
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|Failed to connect/i.test(e));
  if (unreachable) {
    return { failure: 'infrastructure', evidence: `inference endpoint unreachable: ${unreachable.slice(0, 200)}` };
  }
  // A limit WE imposed is not the model failing. Separated so a harness
  // decision can never be counted as evidence about model capability.
  const limitStop = ev.agentErrors.find((e) =>
    /turns on one message|exceeded its .* budget|timed out|Interrupted by user/i.test(e));
  if (limitStop) {
    return { failure: 'budget', evidence: `stopped by a limit: ${limitStop.slice(0, 300)}` };
  }
  // Any other agent-level error is a harness event: the loop stopped, the model
  // did not decline. The tool failures that led there are the actionable part,
  // so they travel with it rather than being reconstructed from logs later.
  if (ev.agentErrors.length > 0) {
    const why = ev.toolFailures.slice(0, 3).join(' | ');
    return {
      failure: 'harness',
      evidence: `agent error: ${ev.agentErrors[0].slice(0, 200)}${why ? ` — preceding tool failures: ${why.slice(0, 400)}` : ''}`,
    };
  }
  // An edit the harness could not apply is a harness failure even though the
  // model produced the text: applying an edit is our job, not the model's.
  const editMiss = ev.toolFailures.find((f) => /^(edit_file|multi_edit|write_file)/.test(f));
  if (editMiss) {
    return { failure: 'harness', evidence: `edit not applied: ${editMiss.slice(0, 300)}` };
  }
  // The suite could not run at all — a broken workspace, a missing dependency,
  // a grader that never executed. Not the model's doing.
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|command not found|No test files found/i.test(ev.suiteOutput)) {
    return { failure: 'grader', evidence: 'suite failed to execute' };
  }
  // Everything the repo already had still passes, and only this commit's own
  // tests fail: possibly a different-but-defensible implementation. Needs a
  // human before it counts as anything.
  if (ev.preExistingSuitePassed === true) {
    return {
      failure: 'alternative-impl',
      evidence: 'pre-existing suite passed; only the commit\'s own tests failed — review before counting',
    };
  }
  // Tests ran and failed on assertions: the change was wrong or incomplete —
  // but only if there is a transcript to check that against. Without one this is
  // an assumption wearing a label.
  if (/AssertionError|expected .* to|✕|FAIL /.test(ev.suiteOutput)) {
    if (!ev.hasEvidence) {
      return {
        failure: 'unclassified',
        evidence: 'assertions failed, but no transcript was captured — a model verdict needs one',
      };
    }
    return { failure: 'model', evidence: 'suite ran; assertions failed (transcript captured for review)' };
  }
  return { failure: 'unclassified', evidence: ev.suiteOutput.slice(-300) };
}

/**
 * Candidate commits from a repo, newest first, that can be replayed as tasks.
 *
 * Returns the tasks AND the reasons others were dropped. The drop reasons are
 * not diagnostics — they are part of the result: a suite built from 6 of 60
 * commits measures a narrow, self-selected slice, and the only honest way to
 * report that is to say how narrow.
 */
export async function discoverRepoTasks(
  repoPath: string,
  opts: { limit?: number; scan?: number; mode?: 'spec' | 'blind'; timeoutMs?: number } = {},
): Promise<{ tasks: RepoTask[]; dropped: Array<{ sha: string; reason: string }> }> {
  const scan = opts.scan ?? 60;
  const limit = opts.limit ?? 10;
  const shas = git(repoPath, ['log', '--no-merges', '-n', String(scan), '--format=%H'])
    .split('\n').filter(Boolean);

  const tasks: RepoTask[] = [];
  const dropped: Array<{ sha: string; reason: string }> = [];
  for (const sha of shas) {
    if (tasks.length >= limit) break;
    let t: RepoTask | string;
    try {
      t = await taskFromCommit(repoPath, sha, opts.timeoutMs ?? 900_000, opts.mode ?? 'blind');
    } catch (err) {
      dropped.push({ sha: sha.slice(0, 9), reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (typeof t === 'string') dropped.push({ sha: sha.slice(0, 9), reason: t });
    else tasks.push(t);
  }
  return { tasks, dropped };
}

/** Run a set of replay tasks and summarise by failure class. */
export async function runRepoSuite(
  tasks: RepoTask[],
  config: Config,
  modelManager: ModelManager,
  opts: { repeat?: number; onProgress?: (msg: string) => void } = {},
): Promise<{ results: RepoTaskResult[]; passRate: number; byClass: Record<string, number> }> {
  const repeat = Math.max(1, opts.repeat ?? 1);
  const results: RepoTaskResult[] = [];
  // Persist after EVERY task. A sweep is hours long and a single kill — a build,
  // an engine restart, an interrupt — used to take the whole thing with it,
  // because results were only written at the end. That already cost three
  // completed tasks once.
  const partial = resolve(process.env.HOME || '~', '.veepee-code', 'repo-evals',
    `.sweep-partial-${new Date().toISOString().slice(0, 10)}.json`);
  for (const [i, task] of tasks.entries()) {
    for (let n = 1; n <= repeat; n++) {
      opts.onProgress?.(`[${i + 1}/${tasks.length}] ${task.name} (${task.mode}${repeat > 1 ? `, run ${n}/${repeat}` : ''}) …`);
      const r = await runRepoTask(task, config, modelManager);
      results.push(r);
      await mkdir(resolve(partial, '..'), { recursive: true }).catch(() => {});
      await writeFile(partial, JSON.stringify({ at: new Date().toISOString(), results }, null, 2)).catch(() => {});
      opts.onProgress?.(
        `[${i + 1}/${tasks.length}] ${task.name}: ${r.passed ? 'PASS' : `FAIL (${r.failure})`} ` +
        `${Math.round(r.wallMs / 1000)}s, ${r.toolCalls} calls${r.selfVerified ? ', self-verified' : ''}` +
        (r.failureEvidence ? `\n        ${r.failureEvidence}` : ''),
      );
    }
  }
  const passes = results.filter((r) => r.passed).length;
  const byClass: Record<string, number> = {};
  for (const r of results) if (!r.passed && r.failure) byClass[r.failure] = (byClass[r.failure] ?? 0) + 1;
  return { results, passRate: results.length ? Math.round((passes / results.length) * 100) : 0, byClass };
}

/** Write a failure's full evidence to disk and return the path. */
async function saveEvidence(task: RepoTask, payload: unknown): Promise<string> {
  const dir = resolve(process.env.HOME || '~', '.veepee-code', 'repo-evals', 'evidence');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${task.name.replace(/[^\w.@-]/g, '_')}-${task.mode}-${stamp}.json`);
  await writeFile(path, JSON.stringify(payload, null, 2));
  return path;
}
