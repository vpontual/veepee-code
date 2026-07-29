/**
 * Goal mode — work autonomously until a command passes.
 *
 * ## Why this exists, and why it looks different from `/ralph`
 *
 * The ralph loop is a *text* loop: a worker model writes prose, a reviewer
 * model critiques the prose, and a model decides when it is done. Nothing runs.
 * For a coding agent that is the wrong shape twice over — the work never
 * touches the repository, and the stopping condition is the model's opinion of
 * its own output, which is exactly the judgement a local model is worst at.
 *
 * Goal mode inverts both. It drives the REAL agent with the real toolset, and
 * the loop terminates on **the exit code of a real command** — the project's
 * own test suite, a build, a linter, whatever the human names. The model never
 * gets a vote on whether it succeeded.
 *
 * ## Why it fits this fleet specifically
 *
 * On metered APIs, "keep trying until the tests pass" is a way to spend money
 * fast, so hosted agents are tuned to stop early and ask. Here inference is
 * already paid for: the DGX and the AGX cost the same whether they sit idle or
 * grind for an hour. Unattended wall-clock is the resource this setup has and
 * a rented one doesn't, and goal mode is the thing that spends it.
 *
 * That advantage disappears the moment the loop spins without progress, so most
 * of the care in here is about noticing that fast:
 *
 *   - the verify output is fingerprinted every attempt, and N identical
 *     failures in a row stops the run as `stalled` rather than burning the
 *     budget re-making the same edit;
 *   - two consecutive agent-level errors (model unreachable, context rejected)
 *     stop it as `failed` in seconds instead of retrying twenty times against
 *     a backend that is down;
 *   - every attempt is checkpointed first, so a run that made things worse is
 *     one `/rewind` away from undone.
 *
 * ## The safety property
 *
 * The verify command is supplied by the human, or derived from the project's
 * own manifest. It is **never written or modified by the model** — otherwise
 * the obvious way to satisfy "make this command pass" is to change what the
 * command is, and the loop's only real stopping condition becomes forgeable.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Agent } from './agent.js';
import type { CheckpointManager } from './checkpoint.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type GoalStatus =
  | 'running'
  /** The verify command exited 0. The only success. */
  | 'succeeded'
  /** Human asked to stop; resumable. */
  | 'paused'
  /** Verify output stopped changing — the loop was going in circles. */
  | 'stalled'
  /** Ran out of attempts, wall clock, or tokens. */
  | 'exhausted'
  /** The agent itself could not run — backend down, context rejected. */
  | 'failed';

export interface GoalAttempt {
  n: number;
  startedAt: string;
  wallMs: number;
  toolCalls: number;
  toolErrors: number;
  /** Prompt + completion tokens reported by the backend for this attempt. */
  tokens: number;
  /** Exit code of the verify command. 0 ends the run. */
  verifyExit: number;
  /** Fingerprint of the verify output, for stall detection. */
  verifyDigest: string;
  /** Tail of the verify output — fed to the next attempt and shown to the user. */
  verifyTail: string;
  /** Checkpoint taken before this attempt, for /rewind. */
  checkpointId: string | null;
  agentError?: string;
}

export interface GoalBudget {
  maxAttempts: number;
  maxWallMs: number;
  /** null = untracked. Tokens are free on this fleet; the cap exists to bound
   *  a runaway loop, not to save money. */
  maxTokens: number | null;
}

export interface GoalState {
  id: string;
  goal: string;
  verifyCommand: string;
  /** Absolute path the run belongs to. Resuming elsewhere is refused. */
  cwd: string;
  model: string;
  status: GoalStatus;
  budget: GoalBudget;
  attempts: GoalAttempt[];
  spent: { wallMs: number; tokens: number };
  /** Why the run ended, in one line. */
  outcome: string;
  createdAt: string;
  updatedAt: string;
}

export type GoalEvent =
  | { type: 'start'; state: GoalState }
  | { type: 'attempt_start'; n: number; of: number; feedback: string | null }
  | { type: 'agent_event'; n: number; event: import('./agent.js').AgentEvent }
  | { type: 'verify_start'; n: number; command: string }
  | { type: 'verify_done'; n: number; exit: number; tail: string }
  | { type: 'note'; message: string }
  | { type: 'done'; state: GoalState };

/** How many identical verify failures in a row count as going in circles. */
export const STALL_THRESHOLD = 3;
/** How many consecutive agent-level errors mean the backend, not the code. */
const AGENT_ERROR_THRESHOLD = 2;
/** Verify output lines carried into the next prompt. Enough to see the failing
 *  assertions, not so many that a 500-test run floods the context. */
const VERIFY_TAIL_LINES = 60;

export const DEFAULT_BUDGET: GoalBudget = {
  maxAttempts: 10,
  maxWallMs: 60 * 60_000,
  maxTokens: null,
};

// ─── Verify command ───────────────────────────────────────────────────────────

/**
 * Work out how to check whether the goal is met, from the project's own files.
 *
 * Only ever reads a manifest — it cannot invent a command, and deliberately
 * prefers what the project already declares over a guess about its stack, so
 * the loop is graded by the same command the human would run.
 */
export function detectVerifyCommand(cwd: string = process.cwd()): string | null {
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      if (typeof scripts.test === 'string' && scripts.test.trim()) return 'npm test';
      if (typeof scripts.build === 'string' && scripts.build.trim()) return 'npm run build';
    } catch { /* fall through to stack detection */ }
  }
  if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'conftest.py'))) return 'pytest';
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(cwd, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(cwd, 'Makefile'))) return 'make test';
  return null;
}

/**
 * Fingerprint verify output so "the same failure again" is detectable.
 *
 * Timings, durations, temp paths and pids change every run and would make two
 * identical failures look like progress, so they are normalised out first.
 */
export function verifyDigest(output: string): string {
  const normalised = output
    .replace(/\d+(\.\d+)?\s*m?s\b/g, 'T')          // 1234ms, 1.2s
    .replace(/\/tmp\/[^\s'":]+/g, 'TMP')            // scratch paths
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, 'TS')// timestamps
    .replace(/\bpid\s*\d+/gi, 'PID')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/** Run the verify command, bounded and group-killed so a hung test suite
 *  cannot strand the loop. */
export function runVerify(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exit: number; output: string }> {
  return new Promise((resolveP) => {
    const proc = spawn('bash', ['-c', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    });
    let output = '';
    let settled = false;
    const finish = (exit: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      resolveP({ exit, output });
    };
    const timer = setTimeout(() => {
      try { if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
      output += `\n[verify timed out after ${timeoutMs}ms]`;
      finish(124);
    }, timeoutMs);
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', (code) => finish(code ?? 1));
    proc.on('error', (err) => { output += String(err.message); finish(1); });
  });
}

export function tailOf(output: string, lines = VERIFY_TAIL_LINES): string {
  return output.split('\n').filter((l) => l.trim()).slice(-lines).join('\n');
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

export function buildGoalPrompt(state: GoalState, last: GoalAttempt | null): string {
  const lines = [
    `Goal: ${state.goal}`,
    '',
    `You are working autonomously toward that goal. This is attempt ${state.attempts.length + 1} of at most ${state.budget.maxAttempts}.`,
    '',
    `Success is decided by one command, which is run for you after you stop:`,
    `    ${state.verifyCommand}`,
    '',
    'That command is fixed. Do not edit it, the scripts it runs, or the tests it',
    'runs in order to make it pass — fix the code it is testing.',
  ];

  if (last) {
    lines.push(
      '',
      `The previous attempt left it failing (exit ${last.verifyExit}):`,
      '```',
      last.verifyTail,
      '```',
      '',
      'Work out the underlying cause and fix it. Run the command yourself to',
      'check your work before you finish.',
    );
    // Repeating a failed approach is the dominant failure mode of a long
    // unattended loop, so name it explicitly once it has actually happened.
    const repeats = countTrailingRepeats(state.attempts);
    if (repeats >= 2) {
      lines.push(
        '',
        `IMPORTANT: the last ${repeats} attempts produced the exact same failure.`,
        'Whatever you have been trying is not working. Investigate somewhere you',
        'have not looked yet before changing anything.',
      );
    }
  } else {
    lines.push('', 'Start by understanding the current state, then make the change.');
  }
  return lines.join('\n');
}

/** How many attempts at the tail of the list share one verify fingerprint. */
export function countTrailingRepeats(attempts: GoalAttempt[]): number {
  if (attempts.length === 0) return 0;
  const last = attempts[attempts.length - 1].verifyDigest;
  let n = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].verifyDigest !== last) break;
    n++;
  }
  return n;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export interface GoalOptions {
  verifyCommand?: string;
  budget?: Partial<GoalBudget>;
  verifyTimeoutMs?: number;
  cwd?: string;
}

export class GoalEngine {
  private paused = false;
  private stateDir: string;

  constructor(
    private agent: Agent,
    private checkpoints: CheckpointManager | null,
    private cwd: string = process.cwd(),
  ) {
    this.stateDir = resolve(this.cwd, '.veepee', 'goals');
  }

  /** Ask the loop to stop after the current attempt and save resumable state. */
  pause(): void {
    this.paused = true;
    this.agent.abort();
  }

  async *run(goal: string, opts: GoalOptions = {}): AsyncGenerator<GoalEvent> {
    const verifyCommand = opts.verifyCommand ?? detectVerifyCommand(this.cwd) ?? '';
    if (!verifyCommand) {
      throw new Error(
        'No verify command. Goal mode needs one command that decides success — ' +
        'pass --verify "<command>" (no test script or known build file was found here).',
      );
    }
    const now = new Date().toISOString();
    const state: GoalState = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      goal,
      verifyCommand,
      cwd: this.cwd,
      model: this.agent.getModelManager().getCurrentModel(),
      status: 'running',
      budget: { ...DEFAULT_BUDGET, ...opts.budget },
      attempts: [],
      spent: { wallMs: 0, tokens: 0 },
      outcome: '',
      createdAt: now,
      updatedAt: now,
    };
    await this.save(state);
    yield { type: 'start', state };
    yield* this.loop(state, opts);
  }

  /**
   * Continue a paused or exhausted run.
   *
   * Re-runs verify before doing anything else: the world may have moved since
   * the pause — the human may have fixed it by hand — and a model call to
   * redo finished work is the one cost worth avoiding here.
   */
  async *resume(id: string, opts: GoalOptions = {}): AsyncGenerator<GoalEvent> {
    const state = await this.load(id);
    if (!state) throw new Error(`No saved goal ${id} in ${this.stateDir}`);
    if (resolve(state.cwd) !== resolve(this.cwd)) {
      throw new Error(`Goal ${id} belongs to ${state.cwd}; resume it from there.`);
    }
    if (state.status === 'succeeded') {
      yield { type: 'note', message: `Goal ${id} already succeeded.` };
      yield { type: 'done', state };
      return;
    }
    if (opts.budget) state.budget = { ...state.budget, ...opts.budget };
    state.status = 'running';
    this.paused = false;
    yield { type: 'start', state };

    yield { type: 'verify_start', n: state.attempts.length, command: state.verifyCommand };
    const check = await runVerify(state.verifyCommand, this.cwd, opts.verifyTimeoutMs ?? 10 * 60_000);
    yield { type: 'verify_done', n: state.attempts.length, exit: check.exit, tail: tailOf(check.output) };
    if (check.exit === 0) {
      yield* this.finish(state, 'succeeded', 'Verify already passes — nothing to do.');
      return;
    }
    yield* this.loop(state, opts);
  }

  private async *loop(state: GoalState, opts: GoalOptions): AsyncGenerator<GoalEvent> {
    const verifyTimeoutMs = opts.verifyTimeoutMs ?? 10 * 60_000;
    let consecutiveAgentErrors = 0;

    while (true) {
      // ── Budget, checked before committing to another attempt ───────────────
      if (state.attempts.length >= state.budget.maxAttempts) {
        yield* this.finish(state, 'exhausted', `Used all ${state.budget.maxAttempts} attempts.`);
        return;
      }
      if (state.spent.wallMs >= state.budget.maxWallMs) {
        yield* this.finish(state, 'exhausted', `Wall-clock budget of ${Math.round(state.budget.maxWallMs / 60000)}m spent.`);
        return;
      }
      if (state.budget.maxTokens !== null && state.spent.tokens >= state.budget.maxTokens) {
        yield* this.finish(state, 'exhausted', `Token budget of ${state.budget.maxTokens} spent.`);
        return;
      }
      if (this.paused) {
        yield* this.finish(state, 'paused', `Paused after ${state.attempts.length} attempt(s). Resume with /goal --resume ${state.id}`);
        return;
      }

      const n = state.attempts.length + 1;
      const last = state.attempts[state.attempts.length - 1] ?? null;
      const attemptStarted = Date.now();

      // Snapshot first, so an attempt that makes things worse is undoable.
      let checkpointId: string | null = null;
      try {
        const cp = await this.checkpoints?.snapshot(`goal ${state.id} attempt ${n}: ${state.goal}`);
        checkpointId = cp?.id ?? null;
      } catch { /* checkpointing is best effort — never fail a run over it */ }

      yield { type: 'attempt_start', n, of: state.budget.maxAttempts, feedback: last?.verifyTail ?? null };

      const attempt: GoalAttempt = {
        n,
        startedAt: new Date(attemptStarted).toISOString(),
        wallMs: 0,
        toolCalls: 0,
        toolErrors: 0,
        tokens: 0,
        verifyExit: -1,
        verifyDigest: '',
        verifyTail: '',
        checkpointId,
      };

      // ── The agent turn ─────────────────────────────────────────────────────
      // A hard deadline on the remaining wall budget, so a single attempt that
      // wanders cannot outlive the whole run's allowance. Measured against
      // cumulative spend, not this process's uptime, so a resumed run inherits
      // what its earlier attempts already used.
      const remainingMs = Math.max(60_000, state.budget.maxWallMs - state.spent.wallMs);
      const deadline = setTimeout(() => this.agent.abort(), remainingMs);
      const agentErrors: string[] = [];
      try {
        for await (const ev of this.agent.run(buildGoalPrompt(state, last), { permissionMode: 'auto_allow' })) {
          if (ev.type === 'tool_call') attempt.toolCalls++;
          else if (ev.type === 'tool_result' && ev.success === false) attempt.toolErrors++;
          else if (ev.type === 'done') attempt.tokens += (ev.evalCount ?? 0) + (ev.promptEvalCount ?? 0);
          else if (ev.type === 'error') agentErrors.push(String(ev.error ?? ev.content ?? 'unknown'));
          yield { type: 'agent_event', n, event: ev };
        }
      } catch (err) {
        agentErrors.push(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(deadline);
      }
      if (agentErrors.length > 0) attempt.agentError = agentErrors.slice(0, 3).join(' | ');

      // The backend being down looks exactly like the model failing the task if
      // you only read the verify exit code. Bail out fast instead of spending
      // the whole budget discovering the same thing ten times.
      consecutiveAgentErrors = agentErrors.length > 0 ? consecutiveAgentErrors + 1 : 0;

      // ── The only thing that decides success ────────────────────────────────
      yield { type: 'verify_start', n, command: state.verifyCommand };
      const check = await runVerify(state.verifyCommand, this.cwd, verifyTimeoutMs);
      attempt.verifyExit = check.exit;
      attempt.verifyTail = tailOf(check.output);
      attempt.verifyDigest = verifyDigest(check.output);
      attempt.wallMs = Date.now() - attemptStarted;

      state.attempts.push(attempt);
      state.spent.wallMs += attempt.wallMs;
      state.spent.tokens += attempt.tokens;
      await this.save(state);
      yield { type: 'verify_done', n, exit: check.exit, tail: attempt.verifyTail };

      if (check.exit === 0) {
        yield* this.finish(state, 'succeeded', `${state.verifyCommand} passed on attempt ${n}.`);
        return;
      }

      // Checked before the failure heuristics below: pausing aborts the agent
      // mid-turn, which registers as an agent error, and a deliberate stop must
      // not be reported as a broken backend.
      if (this.paused) {
        yield* this.finish(state, 'paused', `Paused after ${n} attempt(s). Resume with /goal --resume ${state.id}`);
        return;
      }

      if (consecutiveAgentErrors >= AGENT_ERROR_THRESHOLD) {
        yield* this.finish(
          state,
          'failed',
          `The agent could not run ${consecutiveAgentErrors} times in a row: ${attempt.agentError ?? 'unknown'}`,
        );
        return;
      }

      const repeats = countTrailingRepeats(state.attempts);
      if (repeats >= STALL_THRESHOLD) {
        yield* this.finish(
          state,
          'stalled',
          `The same failure ${repeats} times running — the loop is not making progress. Stopping instead of spending the rest of the budget.`,
        );
        return;
      }
      if (repeats > 1) {
        yield { type: 'note', message: `Same failure as the previous ${repeats - 1} attempt(s) — ${STALL_THRESHOLD - repeats} left before this is called stalled.` };
      }
    }
  }

  private async *finish(state: GoalState, status: GoalStatus, outcome: string): AsyncGenerator<GoalEvent> {
    state.status = status;
    state.outcome = outcome;
    state.updatedAt = new Date().toISOString();
    await this.save(state);
    yield { type: 'done', state };
  }

  private async save(state: GoalState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await mkdir(this.stateDir, { recursive: true });
    // Atomic: this is rewritten every attempt, and a torn file loses a run that
    // may represent an hour of unattended work.
    const target = join(this.stateDir, `${state.id}.json`);
    const tmp = `${target}.tmp-${process.pid}`;
    try {
      await writeFile(tmp, JSON.stringify(state, null, 2));
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  private async load(id: string): Promise<GoalState | null> {
    try {
      return JSON.parse(await readFile(join(this.stateDir, `${id}.json`), 'utf-8')) as GoalState;
    } catch {
      return null;
    }
  }

  /** Saved goal runs for a directory, newest first. */
  static async list(cwd: string = process.cwd()): Promise<GoalState[]> {
    const dir = resolve(cwd, '.veepee', 'goals');
    try {
      const out: GoalState[] = [];
      for (const f of await readdir(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          out.push(JSON.parse(await readFile(join(dir, f), 'utf-8')) as GoalState);
        } catch { /* skip torn/corrupt */ }
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

export interface ParsedGoalArgs {
  list: boolean;
  resume: string | null;
  goal: string;
  verifyCommand?: string;
  budget: Partial<GoalBudget>;
}

/** Split on whitespace, but keep a quoted run together — `--verify "npm test"`
 *  is one value, and losing that turns the success check into `npm`. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Parse the argument string of `/goal …`. Anything not a recognised flag is
 *  the goal text, so the description does not have to be quoted. */
export function parseGoalArgs(argString: string): ParsedGoalArgs {
  const tokens = tokenize(argString);
  const parsed: ParsedGoalArgs = { list: false, resume: null, goal: '', budget: {} };
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const value = tokens[i + 1];
    const positive = (v: string | undefined) => {
      const n = v === undefined ? NaN : Number(v);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    switch (t) {
      case '--list': parsed.list = true; break;
      case '--resume': parsed.resume = value ?? null; i++; break;
      case '--verify': if (value) { parsed.verifyCommand = value; i++; } break;
      case '--max-attempts': { const n = positive(value); if (n) { parsed.budget.maxAttempts = Math.floor(n); i++; } break; }
      case '--budget-minutes': { const n = positive(value); if (n) { parsed.budget.maxWallMs = n * 60_000; i++; } break; }
      case '--max-tokens': { const n = positive(value); if (n) { parsed.budget.maxTokens = Math.floor(n); i++; } break; }
      default: words.push(t);
    }
  }
  parsed.goal = words.join(' ').trim();
  return parsed;
}

/** One-line summary of a run, for `/goal --list`. */
export function formatGoalSummary(state: GoalState): string {
  const mins = Math.round(state.spent.wallMs / 60000);
  const goal = state.goal.length > 48 ? `${state.goal.slice(0, 47)}…` : state.goal;
  return `${state.id}  ${state.status.padEnd(9)}  ${String(state.attempts.length).padStart(2)} attempt(s)  ${mins}m  ${goal}`;
}
