/**
 * Self-improvement — turn eval results into a reviewable proposal.
 *
 * ## What this is
 *
 * `harness-eval.ts` measures the harness. This closes the loop: it reads the
 * saved eval history, works out where vcode is losing, has an agent attempt ONE
 * fix in an isolated git worktree, and then re-measures. If the score did not
 * move, the attempt is rejected. If it did, you get a branch and a report.
 *
 * ## What it deliberately is not
 *
 * It never merges, never pushes, and never deploys. It produces a branch and a
 * report, exactly like the nightly-engineer workflow, because the failure mode
 * of an agent that can modify and ship its own harness is not a bug — it is an
 * agent that has quietly stopped being reviewable.
 *
 * ## Why the "after" measurement runs as a subprocess
 *
 * Running the eval in-process would exercise the Agent class *this* process
 * loaded — the unmodified one. The whole point is to measure the modified
 * harness, so both measurements shell out to the built CLI: the baseline in the
 * repo, the candidate in the worktree after building it there.
 *
 * ## Guarding the exam
 *
 * The obvious way to make a score go up is to edit the thing that produces the
 * score. So a candidate that touches `benchmarks/`, the eval itself, or an
 * EXISTING test file is rejected outright, whatever it did to the number. That
 * is not hypothetical caution: the nightly engineer on this fleet has already
 * been caught weakening a gate to pass it.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HarnessEvalResult } from './harness-eval.js';
import { createWorktree, type WorktreeInfo } from './worktree.js';

// ─── Weakness analysis ────────────────────────────────────────────────────────

export type WeaknessKind =
  | 'regression'
  | 'failing_task'
  | 'tool_errors'
  | 'no_self_verify';

export interface Weakness {
  kind: WeaknessKind;
  /** Higher is worse. Used only for ordering. */
  severity: number;
  title: string;
  /** Concrete numbers from real runs — never a generality. */
  evidence: string;
  /** What an agent should go and change, scoped to the harness. */
  brief: string;
}

/** Strip ANSI so a failure detail reads as evidence rather than as terminal
 *  gibberish — it ends up in a prompt and in a written report. Applied on read
 *  as well as suppressed at capture, since results saved before that are still
 *  in the history. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
export function plain(s: string): string {
  return s.replace(ANSI, '').replace(/\s+/g, ' ').trim();
}

/** A tool-call failure rate above this means the harness is fighting itself. */
const TOOL_ERROR_RATE = 0.25;
const MIN_TOOL_ERRORS = 3;

/**
 * Rank what is going wrong, from saved eval runs.
 *
 * Deterministic on purpose: the point of the eval was to replace "it feels
 * better" with a number, and asking a model to interpret the number would put
 * the guesswork straight back in.
 */
export function analyzeEvalRuns(runs: HarnessEvalResult[]): Weakness[] {
  if (runs.length === 0) return [];
  const sorted = [...runs].sort((a, b) => a.at.localeCompare(b.at));
  const latest = sorted[sorted.length - 1];
  const previous = sorted.length > 1 ? sorted[sorted.length - 2] : null;
  const out: Weakness[] = [];

  for (const r of latest.results) {
    const before = previous?.results.find((p) => p.task === r.task);

    // A task that used to pass and now does not is the most actionable thing
    // there is: something between those two commits caused it.
    if (before?.passed && !r.passed) {
      out.push({
        kind: 'regression',
        severity: 100,
        title: `${r.task} regressed`,
        evidence: plain(`Passed at ${previous?.commit}, fails at ${latest.commit}. ${r.detail.split('\n')[0] ?? ''}`),
        brief: `The harness task "${r.task}" passed at commit ${previous?.commit} and fails at ${latest.commit}. ` +
          `Find what changed in the agent harness between those commits that caused it, and fix that.`,
      });
      continue;
    }

    if (!r.passed) {
      // An agent error is infrastructure, not a harness weakness. Saying "the
      // model wrote bad code" when the fleet was down would send an agent off
      // to fix a bug that does not exist.
      if (r.detail.startsWith('agent error:')) continue;
      out.push({
        kind: 'failing_task',
        severity: 60,
        title: `${r.task} fails`,
        evidence: `${r.toolCalls} tool calls, ${r.toolErrors} errors, ${Math.round(r.wallMs / 1000)}s. ` +
          (plain(r.detail.split('\n').slice(0, 6).join(' ')).slice(0, 400) || 'no detail'),
        brief: `The harness task "${r.task}" fails. Read benchmarks/harness/${r.task}/task.md and its ` +
          `verify.test.ts to understand what is being asked, then improve the HARNESS so the agent gets ` +
          `there — tool descriptions, tool result formatting, the system prompt, context handling. ` +
          `Do not edit the task or its grading test.`,
      });
    }

    if (r.toolCalls > 0 && r.toolErrors >= MIN_TOOL_ERRORS && r.toolErrors / r.toolCalls >= TOOL_ERROR_RATE) {
      out.push({
        kind: 'tool_errors',
        severity: 50,
        title: `${r.task}: ${r.toolErrors}/${r.toolCalls} tool calls failed`,
        evidence: `A ${Math.round((r.toolErrors / r.toolCalls) * 100)}% tool failure rate means the model ` +
          `cannot drive the tools it was given.`,
        brief: `On the harness task "${r.task}", ${r.toolErrors} of ${r.toolCalls} tool calls failed. ` +
          `That is a harness problem, not a model problem: look at the tool descriptions and argument ` +
          `schemas in src/tools/ and at how tool errors are worded, and make the failing calls succeed.`,
      });
    }

    // The force-verify nudge exists to make the agent run the tests itself.
    // A task it failed without ever running them is that nudge not landing.
    if (!r.selfVerified && !r.passed) {
      out.push({
        kind: 'no_self_verify',
        severity: 40,
        title: `${r.task}: finished without running the tests`,
        evidence: `The agent never ran the test suite, then failed. The force-verify nudge did not land.`,
        brief: `On the harness task "${r.task}" the agent finished without ever running the project's ` +
          `tests, and failed. Find where the harness tells the agent to verify its own work (search for ` +
          `the force-verify nudge in src/agent.ts) and make it actually take effect.`,
      });
    }
  }

  return out.sort((a, b) => b.severity - a.severity);
}

/**
 * Is this run worth reasoning about at all?
 *
 * A run where the model was never reached scores 0% and lists every task as
 * failing, which looks exactly like a catastrophic harness regression. Both
 * improving against it and reporting it as "everything failed" would be wrong;
 * the only honest reading is that nothing was measured.
 */
export function evalIsTrustworthy(run: HarnessEvalResult): { ok: boolean; reason: string } {
  const broken = run.results.filter((r) => r.detail.startsWith('agent error:'));
  if (broken.length === 0) return { ok: true, reason: '' };
  const first = broken[0].detail.replace(/^agent error:\s*/, '');
  return {
    ok: false,
    reason: `${broken.length}/${run.results.length} task(s) never reached the model — ${first}`,
  };
}

export async function loadEvalHistory(dir?: string): Promise<HarnessEvalResult[]> {
  const d = dir ?? resolve(process.env.HOME || '~', '.veepee-code', 'harness-evals');
  try {
    const out: HarnessEvalResult[] = [];
    for (const f of await readdir(d)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(await readFile(join(d, f), 'utf-8')) as HarnessEvalResult);
      } catch { /* skip corrupt */ }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return [];
  }
}

// ─── Gate: what a candidate is not allowed to have touched ────────────────────

/** Paths a candidate must not modify — the exam, and the examiner. */
const PROTECTED = [
  { prefix: 'benchmarks/', why: 'the eval tasks are the exam' },
  { prefix: 'src/harness-eval.ts', why: 'that is the examiner' },
  { prefix: 'src/self-improve.ts', why: 'that is this process' },
];

export interface ChangedFile { status: string; path: string }

/**
 * Reject a candidate that changed what grades it.
 *
 * Existing tests are protected too — adding a test for a change is legitimate,
 * rewriting one until it agrees with the change is how a suite stops meaning
 * anything.
 */
export function checkDiffAllowed(files: ChangedFile[]): { ok: boolean; reason: string } {
  for (const f of files) {
    for (const p of PROTECTED) {
      if (f.path.startsWith(p.prefix)) {
        return { ok: false, reason: `modified ${f.path} — ${p.why}` };
      }
    }
    if (f.path.startsWith('test/') && (f.status === 'M' || f.status === 'D')) {
      return { ok: false, reason: `${f.status === 'D' ? 'deleted' : 'modified'} the existing test ${f.path}` };
    }
  }
  if (files.length === 0) return { ok: false, reason: 'changed nothing' };
  return { ok: true, reason: '' };
}

export function parseNameStatus(out: string): ChangedFile[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [status, ...rest] = line.split(/\s+/);
    return { status: status[0], path: rest[rest.length - 1] };
  });
}

// ─── Running things ───────────────────────────────────────────────────────────

export interface CmdResult { code: number; out: string }

export function sh(cmd: string, cwd: string, timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolveP) => {
    const proc = spawn('bash', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
 * Score a checkout by running its own built CLI.
 *
 * Must be a subprocess: measuring the candidate means running the candidate's
 * code, not the copy this process imported at startup.
 */
export async function scoreCheckout(dir: string, timeoutMs = 40 * 60_000): Promise<HarnessEvalResult | null> {
  const r = await sh('node dist/index.js --eval --json', dir, timeoutMs);
  // --eval exits non-zero when tasks fail, which is not an error here; the JSON
  // on stdout is what matters. Everything else goes to stderr.
  const start = r.out.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(r.out.slice(start)) as HarnessEvalResult;
  } catch {
    return null;
  }
}

/** A git worktree has no node_modules of its own. Link the repo's rather than
 *  spending several minutes on `npm ci` for a throwaway checkout. */
export function linkNodeModules(worktreePath: string, repoRoot: string): void {
  const target = join(worktreePath, 'node_modules');
  if (existsSync(target)) return;
  try {
    symlinkSync(join(repoRoot, 'node_modules'), target, 'dir');
  } catch { /* tests will fail loudly enough if this did not work */ }
}

/**
 * Carry the project's own config layer into the worktree.
 *
 * `.veepee/` is gitignored, so a fresh worktree does not have it — and the
 * candidate would then be measured against whatever the GLOBAL config points
 * at while the baseline used the project's. Comparing two scores taken on
 * different models is not a comparison at all.
 */
export function copyProjectConfig(worktreePath: string, repoRoot: string): void {
  for (const name of ['settings.json', 'settings.local.json']) {
    const from = join(repoRoot, '.veepee', name);
    if (!existsSync(from)) continue;
    try {
      mkdirSync(join(worktreePath, '.veepee'), { recursive: true });
      copyFileSync(from, join(worktreePath, '.veepee', name));
    } catch { /* best effort */ }
  }
}

// ─── The proposal ─────────────────────────────────────────────────────────────

export type ImprovementVerdict = 'proposed' | 'rejected';

export interface ImprovementRun {
  at: string;
  weakness: Weakness;
  branch: string;
  worktreePath: string;
  baselineScore: number | null;
  candidateScore: number | null;
  gates: {
    build: boolean;
    tests: boolean;
    diffAllowed: boolean;
    improved: boolean;
  };
  verdict: ImprovementVerdict;
  reason: string;
  changedFiles: ChangedFile[];
  diffStat: string;
}

export function buildImprovementPrompt(w: Weakness): string {
  return [
    'You are improving VEEPEE Code — the coding agent you are running inside — in an isolated git worktree.',
    '',
    'The evaluation suite measured a specific weakness:',
    '',
    `  ${w.title}`,
    `  ${w.evidence}`,
    '',
    'Your task:',
    w.brief,
    '',
    'Rules, all of which are checked afterwards and will reject your work:',
    '  1. Change the HARNESS — src/, the agent loop, tool definitions, prompts.',
    '  2. Do NOT touch benchmarks/ — those tasks are the exam.',
    '  3. Do NOT touch src/harness-eval.ts — that is what grades you.',
    '  4. Do NOT modify or delete an existing file in test/. Adding a new test is welcome.',
    '  5. Make ONE focused change. A large diff is a rejected diff.',
    '',
    'Before you finish, run `npm run build` and `npm test` and make sure both pass.',
  ].join('\n');
}

export interface ProposeOptions {
  repoRoot: string;
  /** Runs the agent against the worktree; injected so this module stays
   *  testable without a model. Returns nothing — the effect is on disk. */
  runAgent: (prompt: string, worktreePath: string) => Promise<string | null>;
  /** Score of the unmodified harness. Skipping the re-measure when this is
   *  null would mean shipping an unmeasured change. */
  baseline: HarnessEvalResult | null;
  buildTimeoutMs?: number;
  testTimeoutMs?: number;
  evalTimeoutMs?: number;
  onProgress?: (msg: string) => void;
}

/**
 * Attempt one improvement and report whether it earned its place.
 *
 * The worktree is left behind either way — a rejected attempt is often the
 * most interesting thing to look at, and deleting the evidence to keep the
 * directory tidy would be the wrong trade.
 */
export async function proposeImprovement(w: Weakness, opts: ProposeOptions): Promise<ImprovementRun> {
  const log = opts.onProgress ?? (() => {});
  let wt: WorktreeInfo;
  try {
    wt = createWorktree(`improve-${w.kind}`, opts.repoRoot);
  } catch (err) {
    throw new Error(`Could not create a worktree: ${err instanceof Error ? err.message : String(err)}`);
  }

  const run: ImprovementRun = {
    at: new Date().toISOString(),
    weakness: w,
    branch: wt.branch,
    worktreePath: wt.path,
    baselineScore: opts.baseline?.score ?? null,
    candidateScore: null,
    gates: { build: false, tests: false, diffAllowed: false, improved: false },
    verdict: 'rejected',
    reason: '',
    changedFiles: [],
    diffStat: '',
  };

  const reject = (reason: string): ImprovementRun => { run.reason = reason; return run; };

  linkNodeModules(wt.path, opts.repoRoot);
  copyProjectConfig(wt.path, opts.repoRoot);

  log(`worktree ${wt.branch}`);
  log('agent working…');
  try {
    await opts.runAgent(buildImprovementPrompt(w), wt.path);
  } catch (err) {
    return reject(`the agent could not run: ${err instanceof Error ? err.message : String(err)}`);
  }

  // What did it actually touch? Checked before the gates are run, because a
  // candidate that edited the exam should not get the dignity of a test run.
  //
  // Everything is staged first, because a plain `git diff` does not see
  // untracked files — so a brand-new file would be invisible to this gate, and
  // "add benchmarks/harness/trivially-easy-task/" would sail straight past the
  // one check meant to stop exactly that.
  //
  // `node_modules` is excluded by pathspec rather than left to .gitignore: the
  // ignore rule is `node_modules/`, which matches a directory, and what we put
  // there is a symlink — which git happily stages as a file, committing a
  // dangling link into every candidate branch.
  await sh(`git add -A -- ':(exclude)node_modules'`, wt.path, 60_000);
  const status = await sh(`git diff --cached --name-status ${wt.baseBranch}`, wt.path, 60_000);
  run.changedFiles = parseNameStatus(status.out);
  const allowed = checkDiffAllowed(run.changedFiles);
  run.gates.diffAllowed = allowed.ok;
  if (!allowed.ok) return reject(allowed.reason);
  run.diffStat = (await sh(`git diff --cached --stat ${wt.baseBranch}`, wt.path, 60_000)).out.trim();

  // Commit on the branch so `git diff main...<branch>` in the report actually
  // shows something. Identity is passed explicitly rather than relying on the
  // repo having user.name configured.
  await sh(
    `git -c user.name=vcode -c user.email=vcode@localhost commit -qm ${JSON.stringify(`self-improve: ${w.title}`)}`,
    wt.path,
    60_000,
  );

  log('gate: build');
  const build = await sh('npm run build', wt.path, opts.buildTimeoutMs ?? 10 * 60_000);
  run.gates.build = build.code === 0;
  if (!run.gates.build) return reject(`build failed:\n${build.out.split('\n').slice(-8).join('\n')}`);

  log('gate: tests');
  const tests = await sh('npm test', wt.path, opts.testTimeoutMs ?? 20 * 60_000);
  run.gates.tests = tests.code === 0;
  if (!run.gates.tests) return reject(`tests failed:\n${tests.out.split('\n').slice(-8).join('\n')}`);

  if (!opts.baseline) {
    return reject('no baseline eval to compare against — cannot tell whether this helped');
  }

  log('re-measuring the modified harness…');
  const after = await scoreCheckout(wt.path, opts.evalTimeoutMs);
  if (!after) return reject('the candidate eval produced no result — cannot tell whether this helped');
  run.candidateScore = after.score;

  if (after.score < opts.baseline.score) {
    return reject(`score dropped ${opts.baseline.score}% → ${after.score}%`);
  }
  if (after.score === opts.baseline.score) {
    return reject(`no measurable improvement (${after.score}%) — the change may still be right, but nothing proves it`);
  }

  run.gates.improved = true;
  run.verdict = 'proposed';
  run.reason = `${opts.baseline.score}% → ${after.score}%`;
  return run;
}

// ─── Reporting ────────────────────────────────────────────────────────────────

export function formatImprovementReport(run: ImprovementRun): string {
  const lines = [
    `# Self-improvement — ${run.verdict.toUpperCase()}`,
    '',
    `- **When:** ${run.at}`,
    `- **Weakness:** ${run.weakness.title}`,
    `- **Evidence:** ${run.weakness.evidence}`,
    `- **Branch:** \`${run.branch}\``,
    `- **Worktree:** \`${run.worktreePath}\``,
    `- **Score:** ${run.baselineScore ?? '—'}% → ${run.candidateScore ?? '—'}%`,
    '',
    '## Gates',
    '',
    `| Gate | Result |`,
    `|---|---|`,
    `| diff stayed out of the exam | ${run.gates.diffAllowed ? 'pass' : 'FAIL'} |`,
    `| build | ${run.gates.build ? 'pass' : 'FAIL'} |`,
    `| tests | ${run.gates.tests ? 'pass' : 'FAIL'} |`,
    `| measurably better | ${run.gates.improved ? 'pass' : 'FAIL'} |`,
    '',
    `**Outcome:** ${run.reason}`,
    '',
  ];
  if (run.changedFiles.length > 0) {
    lines.push('## Files changed', '', '```', ...run.changedFiles.map((f) => `${f.status}  ${f.path}`), '```', '');
  }
  if (run.diffStat) lines.push('```', run.diffStat, '```', '');
  lines.push(
    '## Review',
    '',
    'Nothing has been merged, pushed, or deployed.',
    '',
    '```bash',
    `git diff main...${run.branch}`,
    '```',
  );
  return lines.join('\n');
}

export async function saveImprovementReport(run: ImprovementRun, dir?: string): Promise<string> {
  const outDir = dir ?? resolve(process.env.HOME || '~', '.veepee-code', 'improvements');
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `${run.at.replace(/[:.]/g, '-')}-${run.verdict}.md`);
  await writeFile(path, formatImprovementReport(run));
  return path;
}
