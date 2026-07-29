import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GoalEngine,
  detectVerifyCommand,
  verifyDigest,
  countTrailingRepeats,
  buildGoalPrompt,
  runVerify,
  tailOf,
  formatGoalSummary,
  parseGoalArgs,
  STALL_THRESHOLD,
  type GoalEvent,
  type GoalState,
  type GoalAttempt,
} from '../src/goal.js';
import type { AgentEvent } from '../src/agent.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vcode-goal-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/**
 * A stand-in for the real Agent. Each turn runs the next scripted action, so a
 * whole autonomous loop can be exercised without a model or a network.
 */
function fakeAgent(turns: Array<() => AgentEvent[]>) {
  let i = 0;
  const calls: string[] = [];
  let aborted = 0;
  return {
    calls,
    get abortCount() { return aborted; },
    abort() { aborted++; },
    getModelManager: () => ({ getCurrentModel: () => 'test-model' }),
    run(prompt: string): AsyncGenerator<AgentEvent> {
      calls.push(prompt);
      const events = (turns[i] ?? turns[turns.length - 1] ?? (() => []))();
      i++;
      return (async function* () { for (const e of events) yield e; })();
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAgent = (a: unknown) => a as any;

async function collect(gen: AsyncGenerator<GoalEvent>): Promise<GoalEvent[]> {
  const out: GoalEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function finalState(events: GoalEvent[]): GoalState {
  const done = events.filter((e) => e.type === 'done').pop();
  if (!done || done.type !== 'done') throw new Error('no done event');
  return done.state;
}

/** Verify passes only once the marker file exists — lets a fake agent "fix" it. */
const MARKER_VERIFY = 'test -f fixed';

describe('detectVerifyCommand', () => {
  it('prefers the project\'s own test script over guessing its stack', () => {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } }));
    expect(detectVerifyCommand(tmp)).toBe('npm test');
  });

  it('falls back to build when there is no test script', () => {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    expect(detectVerifyCommand(tmp)).toBe('npm run build');
  });

  it('ignores an empty test script rather than running a no-op as the success check', () => {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ scripts: { test: '   ' } }));
    expect(detectVerifyCommand(tmp)).toBeNull();
  });

  it('recognises non-node projects', () => {
    writeFileSync(join(tmp, 'Cargo.toml'), '[package]');
    expect(detectVerifyCommand(tmp)).toBe('cargo test');
  });

  it('survives a malformed package.json', () => {
    writeFileSync(join(tmp, 'package.json'), '{ not json');
    expect(detectVerifyCommand(tmp)).toBeNull();
  });

  it('returns null when nothing in the project declares how to check itself', () => {
    expect(detectVerifyCommand(tmp)).toBeNull();
  });
});

describe('verifyDigest', () => {
  it('treats two identical failures as identical', () => {
    const out = 'FAIL src/a.test.ts\n  expected 1 to be 2';
    expect(verifyDigest(out)).toBe(verifyDigest(out));
  });

  it('ignores timings, temp paths and pids, which change every single run', () => {
    const a = 'FAIL in 1234ms at /tmp/abc123/x.ts pid 4242';
    const b = 'FAIL in 9.9s at /tmp/zzz999/x.ts pid 17';
    expect(verifyDigest(a)).toBe(verifyDigest(b));
  });

  it('still distinguishes a genuinely different failure', () => {
    expect(verifyDigest('expected 1 to be 2')).not.toBe(verifyDigest('expected 3 to be 4'));
  });
});

describe('countTrailingRepeats', () => {
  const at = (digest: string): GoalAttempt => ({
    n: 1, startedAt: '', wallMs: 0, toolCalls: 0, toolErrors: 0, tokens: 0,
    verifyExit: 1, verifyDigest: digest, verifyTail: '', checkpointId: null,
  });

  it('counts only the unbroken run at the end', () => {
    expect(countTrailingRepeats([at('a'), at('b'), at('b'), at('b')])).toBe(3);
  });

  it('resets when the failure changes', () => {
    expect(countTrailingRepeats([at('b'), at('b'), at('a')])).toBe(1);
  });

  it('handles an empty history', () => {
    expect(countTrailingRepeats([])).toBe(0);
  });
});

describe('runVerify', () => {
  it('reports the exit code and output of a real command', async () => {
    const r = await runVerify('echo hello; exit 3', tmp, 10_000);
    expect(r.exit).toBe(3);
    expect(r.output).toContain('hello');
  });

  it('kills a hung command instead of stranding the loop forever', async () => {
    const r = await runVerify('sleep 30', tmp, 700);
    expect(r.exit).toBe(124);
    expect(r.output).toContain('timed out');
  }, 15_000);

  it('runs in the goal directory', async () => {
    writeFileSync(join(tmp, 'marker'), '');
    expect((await runVerify('test -f marker', tmp, 10_000)).exit).toBe(0);
  });
});

describe('buildGoalPrompt', () => {
  const base: GoalState = {
    id: 'g1', goal: 'make the tests pass', verifyCommand: 'npm test', cwd: '/x',
    model: 'm', status: 'running',
    budget: { maxAttempts: 5, maxWallMs: 1000, maxTokens: null },
    attempts: [], spent: { wallMs: 0, tokens: 0 }, outcome: '',
    createdAt: '', updatedAt: '',
  };

  it('forbids editing the thing that grades the work', () => {
    const p = buildGoalPrompt(base, null);
    expect(p).toContain('npm test');
    expect(p).toMatch(/do not edit it/i);
  });

  it('feeds the previous failure back in', () => {
    const last: GoalAttempt = {
      n: 1, startedAt: '', wallMs: 0, toolCalls: 0, toolErrors: 0, tokens: 0,
      verifyExit: 1, verifyDigest: 'a', verifyTail: 'expected 1 to be 2', checkpointId: null,
    };
    expect(buildGoalPrompt({ ...base, attempts: [last] }, last)).toContain('expected 1 to be 2');
  });

  it('calls out a repeated failure so the model stops re-trying the same fix', () => {
    const mk = (n: number): GoalAttempt => ({
      n, startedAt: '', wallMs: 0, toolCalls: 0, toolErrors: 0, tokens: 0,
      verifyExit: 1, verifyDigest: 'same', verifyTail: 'boom', checkpointId: null,
    });
    const attempts = [mk(1), mk(2)];
    const p = buildGoalPrompt({ ...base, attempts }, attempts[1]);
    expect(p).toMatch(/same failure/i);
  });

  it('says nothing about repetition on the first attempt', () => {
    expect(buildGoalPrompt(base, null)).not.toMatch(/same failure/i);
  });
});

describe('GoalEngine — the loop', () => {
  it('stops the moment the verify command passes, and calls that the success', async () => {
    const agent = fakeAgent([() => { writeFileSync(join(tmp, 'fixed'), ''); return []; }]);
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    const events = await collect(engine.run('fix it', { verifyCommand: MARKER_VERIFY }));
    const state = finalState(events);

    expect(state.status).toBe('succeeded');
    expect(state.attempts).toHaveLength(1);
    expect(agent.calls).toHaveLength(1);
  });

  it('never succeeds on the model\'s say-so — only on the exit code', async () => {
    // The agent claims success and does nothing. The loop must not believe it.
    const agent = fakeAgent([() => [{ type: 'text', content: 'Done! All tests pass.' } as AgentEvent]]);
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    const state = finalState(await collect(
      engine.run('fix it', { verifyCommand: MARKER_VERIFY, budget: { maxAttempts: 1 } }),
    ));
    expect(state.status).toBe('exhausted');
  });

  it('stops as stalled when the same failure repeats, without burning the budget', async () => {
    const agent = fakeAgent([() => []]); // does nothing, forever
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    const state = finalState(await collect(
      engine.run('fix it', { verifyCommand: 'echo always the same; exit 1', budget: { maxAttempts: 20 } }),
    ));

    expect(state.status).toBe('stalled');
    expect(state.attempts).toHaveLength(STALL_THRESHOLD);
    expect(agent.calls.length).toBe(STALL_THRESHOLD); // not 20
  }, 30_000);

  it('keeps going while the failure is still changing', async () => {
    let i = 0;
    const agent = fakeAgent([() => { i++; return []; }]);
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    // A different message each run, so the digest changes and it is not a stall.
    const state = finalState(await collect(engine.run('fix it', {
      verifyCommand: 'cat counter 2>/dev/null; echo x >> counter; exit 1',
      budget: { maxAttempts: 4 },
    })));

    expect(state.status).toBe('exhausted');
    expect(state.attempts).toHaveLength(4);
    expect(i).toBe(4);
  }, 30_000);

  it('bails out fast when the agent itself cannot run — a dead backend is not a code failure', async () => {
    const agent = fakeAgent([() => [
      { type: 'error', error: "model 'Qwen3.6' not found on any available server" } as AgentEvent,
    ]]);
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    const state = finalState(await collect(
      engine.run('fix it', { verifyCommand: 'exit 1', budget: { maxAttempts: 20 } }),
    ));

    expect(state.status).toBe('failed');
    expect(state.outcome).toContain('not found');
    expect(state.attempts).toHaveLength(2); // not 20
  }, 30_000);

  it('treats a thrown agent error the same way rather than crashing the run', async () => {
    const engine = new GoalEngine(asAgent({
      abort() {},
      getModelManager: () => ({ getCurrentModel: () => 'm' }),
      run() { throw new Error('agent busy'); },
    }), null, tmp);
    const state = finalState(await collect(
      engine.run('fix it', { verifyCommand: 'exit 1', budget: { maxAttempts: 5 } }),
    ));
    expect(state.status).toBe('failed');
    expect(state.outcome).toContain('agent busy');
  });

  it('refuses to start without a command that decides success', async () => {
    const engine = new GoalEngine(asAgent(fakeAgent([() => []])), null, tmp);
    await expect(collect(engine.run('fix it'))).rejects.toThrow(/verify command/i);
  });

  it('checkpoints before each attempt so a bad run is undoable', async () => {
    const labels: string[] = [];
    const checkpoints = {
      snapshot: async (label: string) => { labels.push(label); return { id: `cp${labels.length}` }; },
    };
    const agent = fakeAgent([() => []]);
    const engine = new GoalEngine(asAgent(agent), checkpoints as never, tmp);
    const state = finalState(await collect(
      engine.run('fix it', { verifyCommand: 'exit 1', budget: { maxAttempts: 2 } }),
    ));

    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('fix it');
    expect(state.attempts.map((a) => a.checkpointId)).toEqual(['cp1', 'cp2']);
  }, 20_000);

  it('does not fail the run when checkpointing is broken', async () => {
    const checkpoints = { snapshot: async () => { throw new Error('no git'); } };
    const agent = fakeAgent([() => { writeFileSync(join(tmp, 'fixed'), ''); return []; }]);
    const engine = new GoalEngine(asAgent(agent), checkpoints as never, tmp);
    const state = finalState(await collect(engine.run('fix it', { verifyCommand: MARKER_VERIFY })));
    expect(state.status).toBe('succeeded');
    expect(state.attempts[0].checkpointId).toBeNull();
  });

  it('records the metrics that make a long unattended run reviewable', async () => {
    const agent = fakeAgent([() => {
      writeFileSync(join(tmp, 'fixed'), '');
      return [
        { type: 'tool_call', name: 'read_file' } as AgentEvent,
        { type: 'tool_result', success: false } as AgentEvent,
        { type: 'tool_call', name: 'edit_file' } as AgentEvent,
        { type: 'done', evalCount: 120, promptEvalCount: 30 } as AgentEvent,
      ];
    }]);
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    const state = finalState(await collect(engine.run('fix it', { verifyCommand: MARKER_VERIFY })));

    expect(state.attempts[0].toolCalls).toBe(2);
    expect(state.attempts[0].toolErrors).toBe(1);
    expect(state.spent.tokens).toBe(150);
    expect(state.attempts[0].wallMs).toBeGreaterThan(0);
  });

  it('stops on the token budget', async () => {
    const agent = fakeAgent([() => [{ type: 'done', evalCount: 900, promptEvalCount: 200 } as AgentEvent]]);
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    const state = finalState(await collect(engine.run('fix it', {
      verifyCommand: 'echo $RANDOM; exit 1',
      budget: { maxAttempts: 50, maxTokens: 1000 },
    })));
    expect(state.status).toBe('exhausted');
    expect(state.outcome).toMatch(/token budget/i);
    expect(state.attempts).toHaveLength(1);
  }, 20_000);
});

describe('GoalEngine — pause and resume', () => {
  it('pausing saves a resumable run instead of losing the work', async () => {
    const agent = fakeAgent([() => []]);
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    const events: GoalEvent[] = [];
    for await (const e of engine.run('fix it', { verifyCommand: 'exit 1', budget: { maxAttempts: 10 } })) {
      events.push(e);
      if (e.type === 'verify_done') engine.pause();
    }
    const state = finalState(events);
    expect(state.status).toBe('paused');
    expect(state.attempts).toHaveLength(1);
    expect(existsSync(join(tmp, '.veepee', 'goals', `${state.id}.json`))).toBe(true);
  }, 20_000);

  it('re-checks the world on resume before spending a single model call', async () => {
    const agent = fakeAgent([() => []]);
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    const first = finalState(await collect(
      engine.run('fix it', { verifyCommand: MARKER_VERIFY, budget: { maxAttempts: 1 } }),
    ));
    expect(first.status).toBe('exhausted');

    // The human fixed it by hand in the meantime.
    writeFileSync(join(tmp, 'fixed'), '');
    const callsBefore = agent.calls.length;
    const resumed = finalState(await collect(engine.resume(first.id)));

    expect(resumed.status).toBe('succeeded');
    expect(agent.calls.length).toBe(callsBefore); // no model call at all
  }, 20_000);

  it('continues working when resume finds it still failing', async () => {
    const agent = fakeAgent([() => []]);
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    const first = finalState(await collect(
      engine.run('fix it', { verifyCommand: MARKER_VERIFY, budget: { maxAttempts: 1 } }),
    ));

    const agent2 = fakeAgent([() => { writeFileSync(join(tmp, 'fixed'), ''); return []; }]);
    const engine2 = new GoalEngine(asAgent(agent2), null, tmp);
    const resumed = finalState(await collect(engine2.resume(first.id, { budget: { maxAttempts: 3 } })));

    expect(resumed.status).toBe('succeeded');
    expect(agent2.calls).toHaveLength(1);
    expect(resumed.attempts.length).toBe(2); // the earlier attempt is kept
  }, 20_000);

  it('refuses to resume a run that belongs to another directory', async () => {
    const agent = fakeAgent([() => []]);
    const engine = new GoalEngine(asAgent(agent), null, tmp);
    const first = finalState(await collect(
      engine.run('fix it', { verifyCommand: 'exit 1', budget: { maxAttempts: 1 } }),
    ));

    const other = mkdtempSync(join(tmpdir(), 'vcode-goal-other-'));
    mkdirSync(join(other, '.veepee', 'goals'), { recursive: true });
    writeFileSync(
      join(other, '.veepee', 'goals', `${first.id}.json`),
      JSON.stringify({ ...first, cwd: tmp }),
    );
    try {
      const elsewhere = new GoalEngine(asAgent(agent), null, other);
      await expect(collect(elsewhere.resume(first.id))).rejects.toThrow(/belongs to/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 20_000);

  it('reports an unknown id rather than starting something new', async () => {
    const engine = new GoalEngine(asAgent(fakeAgent([() => []])), null, tmp);
    await expect(collect(engine.resume('nope'))).rejects.toThrow(/No saved goal/);
  });
});

describe('GoalEngine.list', () => {
  it('lists saved runs newest first and skips corrupt files', async () => {
    const dir = join(tmp, '.veepee', 'goals');
    mkdirSync(dir, { recursive: true });
    const mk = (id: string, updatedAt: string) => JSON.stringify({
      id, goal: 'g', verifyCommand: 'npm test', cwd: tmp, model: 'm', status: 'paused',
      budget: { maxAttempts: 1, maxWallMs: 1, maxTokens: null }, attempts: [],
      spent: { wallMs: 0, tokens: 0 }, outcome: '', createdAt: updatedAt, updatedAt,
    });
    writeFileSync(join(dir, 'a.json'), mk('a', '2026-07-01T00:00:00.000Z'));
    writeFileSync(join(dir, 'b.json'), mk('b', '2026-07-29T00:00:00.000Z'));
    writeFileSync(join(dir, 'torn.json'), '{ half-writ');

    expect((await GoalEngine.list(tmp)).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('returns nothing for a directory that has never run one', async () => {
    expect(await GoalEngine.list(tmp)).toEqual([]);
  });
});

describe('parseGoalArgs', () => {
  it('keeps a quoted verify command in one piece', () => {
    // Splitting on whitespace here would set the success check to `npm`, which
    // exits 1 forever and makes every run look like a model failure.
    const a = parseGoalArgs('--verify "npm test -- --run" fix the failing suite');
    expect(a.verifyCommand).toBe('npm test -- --run');
    expect(a.goal).toBe('fix the failing suite');
  });

  it('accepts single quotes too', () => {
    expect(parseGoalArgs(`--verify 'cargo test' make it green`).verifyCommand).toBe('cargo test');
  });

  it('takes unquoted goal text as the goal', () => {
    const a = parseGoalArgs('make the auth middleware handle expired tokens');
    expect(a.goal).toBe('make the auth middleware handle expired tokens');
    expect(a.verifyCommand).toBeUndefined();
  });

  it('parses budget flags', () => {
    const a = parseGoalArgs('--max-attempts 20 --budget-minutes 90 --max-tokens 500000 do it');
    expect(a.budget.maxAttempts).toBe(20);
    expect(a.budget.maxWallMs).toBe(90 * 60_000);
    expect(a.budget.maxTokens).toBe(500_000);
    expect(a.goal).toBe('do it');
  });

  it('ignores nonsense budget values instead of setting a zero budget', () => {
    const a = parseGoalArgs('--max-attempts zero --budget-minutes -5 do it');
    expect(a.budget.maxAttempts).toBeUndefined();
    expect(a.budget.maxWallMs).toBeUndefined();
    expect(a.goal).toContain('do it');
  });

  it('recognises --list and --resume', () => {
    expect(parseGoalArgs('--list').list).toBe(true);
    expect(parseGoalArgs('--resume ab12cd').resume).toBe('ab12cd');
  });

  it('does not swallow the goal when a flag comes last', () => {
    expect(parseGoalArgs('fix the tests --max-attempts 3').goal).toBe('fix the tests');
  });
});

describe('formatting', () => {
  it('summarises a run in one line', () => {
    const s: GoalState = {
      id: 'abc', goal: 'make the flaky integration tests pass reliably every time',
      verifyCommand: 'npm test', cwd: '/x', model: 'm', status: 'succeeded',
      budget: { maxAttempts: 5, maxWallMs: 1, maxTokens: null },
      attempts: [], spent: { wallMs: 125_000, tokens: 0 }, outcome: '',
      createdAt: '', updatedAt: '',
    };
    const line = formatGoalSummary(s);
    expect(line).toContain('abc');
    expect(line).toContain('succeeded');
    expect(line).toContain('2m');
    expect(line).toContain('…'); // long goal truncated
  });

  it('keeps only the tail of a huge test log', () => {
    const out = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const t = tailOf(out, 10);
    expect(t.split('\n')).toHaveLength(10);
    expect(t).toContain('line 499');
  });
});
