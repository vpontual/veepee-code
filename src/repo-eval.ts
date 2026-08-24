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
}

export interface RepoTaskResult {
  task: string;
  passed: boolean;
  /** The suite failed before the agent ran, as a valid task requires. */
  startedFailing: boolean;
  toolCalls: number;
  toolErrors: number;
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
export async function taskFromCommit(repoPath: string, sha: string, timeoutMs = 900_000): Promise<RepoTask | string> {
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
      'The tests for this change are already written and currently failing.',
      'Implement it so they pass, then run the suite.',
    ].filter(Boolean).join('\n\n'),
    testFiles,
    srcFiles,
    testCommand,
    timeoutMs,
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
  // Restore ONLY the tests, so the grader exists and the implementation does not.
  git(work, ['checkout', task.sha, '--', ...task.testFiles]);

  const nm = join(task.repoPath, 'node_modules');
  if (existsSync(nm) && !existsSync(join(work, 'node_modules'))) {
    try { symlinkSync(nm, join(work, 'node_modules'), 'dir'); } catch { /* optional */ }
  }
  return work;
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
