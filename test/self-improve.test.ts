import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  analyzeEvalRuns,
  evalIsTrustworthy,
  loadEvalHistory,
  checkDiffAllowed,
  parseNameStatus,
  buildImprovementPrompt,
  proposeImprovement,
  formatImprovementReport,
  saveImprovementReport,
  linkNodeModules,
  copyProjectConfig,
  sh,
  type Weakness,
  type ImprovementRun,
} from '../src/self-improve.js';
import type { HarnessEvalResult, HarnessTaskResult } from '../src/harness-eval.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vcode-si-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function task(over: Partial<HarnessTaskResult> = {}): HarnessTaskResult {
  return {
    task: 't1', passed: true, detail: '', tags: [], turns: 1,
    toolCalls: 10, toolErrors: 0, selfVerified: true, wallMs: 1000, model: 'm',
    ...over,
  };
}

function run(over: Partial<HarnessEvalResult> = {}): HarnessEvalResult {
  const results = over.results ?? [task()];
  const passed = results.filter((r) => r.passed).length;
  return {
    at: '2026-07-29T10:00:00.000Z', model: 'm', commit: 'aaa',
    passed, total: results.length,
    score: Math.round((passed / results.length) * 100),
    ...over,
    results,
  };
}

describe('analyzeEvalRuns', () => {
  it('ranks a regression above everything else — it has a known cause', () => {
    const before = run({ at: '2026-07-29T09:00:00.000Z', commit: 'aaa', results: [task({ task: 'alpha' })] });
    const after = run({
      at: '2026-07-29T10:00:00.000Z', commit: 'bbb',
      results: [task({ task: 'alpha', passed: false, detail: 'expected 1 to be 2' })],
    });
    const [top] = analyzeEvalRuns([before, after]);

    expect(top.kind).toBe('regression');
    expect(top.evidence).toContain('aaa');
    expect(top.evidence).toContain('bbb');
    expect(top.brief).toContain('alpha');
  });

  it('does not blame the harness when the fleet was down', () => {
    // "agent error" means the model was never reached. Filing that as a code
    // weakness sends an agent off to fix a bug that does not exist.
    const r = run({ results: [task({ passed: false, detail: 'agent error: model not found on any server' })] });
    expect(analyzeEvalRuns([r])).toEqual([]);
  });

  it('strips terminal escapes out of the evidence it puts in a prompt', () => {
    const r = run({ results: [task({ passed: false, detail: '\u001b[31mFAIL\u001b[39m expected 1 to be 2' })] });
    const w = analyzeEvalRuns([r]).find((x) => x.kind === 'failing_task');
    expect(w?.evidence).toContain('FAIL expected 1 to be 2');
    expect(w?.evidence).not.toMatch(/\u001b/);
  });

  it('flags a failing task with its real numbers, not a generality', () => {
    const r = run({ results: [task({ task: 'beta', passed: false, detail: 'AssertionError: 3 != 4', toolCalls: 12, toolErrors: 1, wallMs: 42_000 })] });
    const w = analyzeEvalRuns([r]).find((x) => x.kind === 'failing_task');
    expect(w?.evidence).toContain('12 tool calls');
    expect(w?.evidence).toContain('42s');
    expect(w?.evidence).toContain('AssertionError');
  });

  it('flags a high tool failure rate as a harness problem', () => {
    const r = run({ results: [task({ passed: true, toolCalls: 10, toolErrors: 4 })] });
    const w = analyzeEvalRuns([r]).find((x) => x.kind === 'tool_errors');
    expect(w).toBeDefined();
    expect(w?.title).toContain('4/10');
    expect(w?.brief).toContain('src/tools/');
  });

  it('ignores one or two stray tool errors', () => {
    const r = run({ results: [task({ toolCalls: 4, toolErrors: 2 })] });
    expect(analyzeEvalRuns([r]).some((w) => w.kind === 'tool_errors')).toBe(false);
  });

  it('flags a failure where the agent never ran the tests', () => {
    const r = run({ results: [task({ passed: false, detail: 'x', selfVerified: false })] });
    const w = analyzeEvalRuns([r]).find((x) => x.kind === 'no_self_verify');
    expect(w?.brief).toContain('force-verify');
  });

  it('does not nag about self-verification on a task that passed', () => {
    const r = run({ results: [task({ passed: true, selfVerified: false })] });
    expect(analyzeEvalRuns([r]).some((w) => w.kind === 'no_self_verify')).toBe(false);
  });

  it('finds nothing to do when everything passed cleanly', () => {
    expect(analyzeEvalRuns([run()])).toEqual([]);
  });

  it('handles no history at all', () => {
    expect(analyzeEvalRuns([])).toEqual([]);
  });
});

describe('evalIsTrustworthy', () => {
  it('rejects a run where the model was never reached', () => {
    // 0% with an agent error on every task is a dead backend, not a harness
    // collapse — and improving against it would be chasing noise.
    const r = run({ results: [task({ passed: false, detail: "agent error: model 'Qwen' not found on any available server" })] });
    const v = evalIsTrustworthy(r);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('never reached the model');
    expect(v.reason).toContain('not found');
  });

  it('accepts a run whose failures are real code failures', () => {
    expect(evalIsTrustworthy(run({ results: [task({ passed: false, detail: 'expected 1 to be 2' })] })).ok).toBe(true);
  });

  it('accepts a clean run', () => {
    expect(evalIsTrustworthy(run()).ok).toBe(true);
  });
});

describe('loadEvalHistory', () => {
  it('reads runs oldest-first and skips corrupt files', async () => {
    writeFileSync(join(tmp, 'b.json'), JSON.stringify(run({ at: '2026-07-29T11:00:00.000Z', commit: 'bbb' })));
    writeFileSync(join(tmp, 'a.json'), JSON.stringify(run({ at: '2026-07-29T09:00:00.000Z', commit: 'aaa' })));
    writeFileSync(join(tmp, 'torn.json'), '{ half');
    expect((await loadEvalHistory(tmp)).map((r) => r.commit)).toEqual(['aaa', 'bbb']);
  });

  it('returns nothing when no eval has ever run', async () => {
    expect(await loadEvalHistory(join(tmp, 'nope'))).toEqual([]);
  });
});

describe('checkDiffAllowed — guarding the exam', () => {
  it('rejects a candidate that edited the benchmark tasks', () => {
    const v = checkDiffAllowed([{ status: 'M', path: 'benchmarks/harness/fix-failing-test/verify.test.ts' }]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/exam/);
  });

  it('rejects a candidate that edited the thing that grades it', () => {
    expect(checkDiffAllowed([{ status: 'M', path: 'src/harness-eval.ts' }]).ok).toBe(false);
  });

  it('rejects a candidate that rewrote this module to remove its own gates', () => {
    expect(checkDiffAllowed([{ status: 'M', path: 'src/self-improve.ts' }]).ok).toBe(false);
  });

  it('rejects modifying an existing test', () => {
    const v = checkDiffAllowed([{ status: 'M', path: 'test/agent.test.ts' }]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/modified the existing test/);
  });

  it('rejects deleting a test outright', () => {
    expect(checkDiffAllowed([{ status: 'D', path: 'test/agent.test.ts' }]).ok).toBe(false);
  });

  it('allows adding a new test alongside a source change', () => {
    const v = checkDiffAllowed([
      { status: 'M', path: 'src/agent.ts' },
      { status: 'A', path: 'test/new-behaviour.test.ts' },
    ]);
    expect(v.ok).toBe(true);
  });

  it('rejects a candidate that changed nothing', () => {
    expect(checkDiffAllowed([]).ok).toBe(false);
  });
});

describe('parseNameStatus', () => {
  it('reads git\'s status letters and paths', () => {
    expect(parseNameStatus('M\tsrc/agent.ts\nA\ttest/x.test.ts\n')).toEqual([
      { status: 'M', path: 'src/agent.ts' },
      { status: 'A', path: 'test/x.test.ts' },
    ]);
  });

  it('takes the destination path of a rename', () => {
    expect(parseNameStatus('R100\tsrc/old.ts\tsrc/new.ts')).toEqual([{ status: 'R', path: 'src/new.ts' }]);
  });

  it('ignores blank lines', () => {
    expect(parseNameStatus('\n\n')).toEqual([]);
  });
});

describe('buildImprovementPrompt', () => {
  const w: Weakness = {
    kind: 'failing_task', severity: 60, title: 'beta fails',
    evidence: '12 tool calls, 1 error', brief: 'Fix the harness so beta passes.',
  };

  it('states every rule that will be enforced afterwards', () => {
    const p = buildImprovementPrompt(w);
    expect(p).toContain('benchmarks/');
    expect(p).toContain('src/harness-eval.ts');
    expect(p).toMatch(/existing file in test\//);
    expect(p).toContain('npm test');
  });

  it('carries the concrete evidence, not just the title', () => {
    expect(buildImprovementPrompt(w)).toContain('12 tool calls, 1 error');
  });
});

describe('sh', () => {
  it('reports exit code and output', async () => {
    const r = await sh('echo out; echo err >&2; exit 7', tmp, 10_000);
    expect(r.code).toBe(7);
    expect(r.out).toContain('out');
    expect(r.out).toContain('err');
  });

  it('kills a hung command', async () => {
    const r = await sh('sleep 30', tmp, 700);
    expect(r.code).toBe(124);
  }, 15_000);
});

describe('linkNodeModules', () => {
  it('links the repo\'s modules into a fresh worktree', () => {
    mkdirSync(join(tmp, 'repo', 'node_modules'), { recursive: true });
    mkdirSync(join(tmp, 'wt'), { recursive: true });
    linkNodeModules(join(tmp, 'wt'), join(tmp, 'repo'));
    expect(existsSync(join(tmp, 'wt', 'node_modules'))).toBe(true);
  });

  it('carries the project config layer in, so both scores use the same model', () => {
    // .veepee/ is gitignored, so a fresh worktree would fall back to the global
    // config — and the candidate would be measured on a different backend than
    // the baseline, which makes the comparison meaningless.
    mkdirSync(join(tmp, 'repo', '.veepee'), { recursive: true });
    writeFileSync(join(tmp, 'repo', '.veepee', 'settings.local.json'), '{"model":"gemma4:26b-a4b"}');
    mkdirSync(join(tmp, 'wt2'), { recursive: true });
    copyProjectConfig(join(tmp, 'wt2'), join(tmp, 'repo'));
    expect(readFileSync(join(tmp, 'wt2', '.veepee', 'settings.local.json'), 'utf-8')).toContain('gemma4');
  });

  it('copies nothing when the project has no config of its own', () => {
    mkdirSync(join(tmp, 'repo2'), { recursive: true });
    mkdirSync(join(tmp, 'wt3'), { recursive: true });
    copyProjectConfig(join(tmp, 'wt3'), join(tmp, 'repo2'));
    expect(existsSync(join(tmp, 'wt3', '.veepee'))).toBe(false);
  });

  it('leaves an existing node_modules alone', () => {
    mkdirSync(join(tmp, 'repo', 'node_modules'), { recursive: true });
    mkdirSync(join(tmp, 'wt', 'node_modules'), { recursive: true });
    writeFileSync(join(tmp, 'wt', 'node_modules', 'marker'), '');
    linkNodeModules(join(tmp, 'wt'), join(tmp, 'repo'));
    expect(existsSync(join(tmp, 'wt', 'node_modules', 'marker'))).toBe(true);
  });
});

/**
 * The gate ladder, exercised against a real git repo and a real worktree but
 * with a scripted "agent" — the point is whether a bad candidate is stopped,
 * which has nothing to do with a model.
 */
describe('proposeImprovement — the gate ladder', () => {
  let repo: string;

  const weakness: Weakness = {
    kind: 'failing_task', severity: 60, title: 'beta fails',
    evidence: 'evidence', brief: 'do the thing',
  };

  const baseline = run({ score: 50, results: [task({ passed: true }), task({ task: 't2', passed: false })] });

  beforeEach(() => {
    repo = join(tmp, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    mkdirSync(join(repo, 'benchmarks'), { recursive: true });
    writeFileSync(join(repo, 'src', 'agent.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'test', 'a.test.ts'), 'export {};\n');
    writeFileSync(join(repo, 'benchmarks', 'task.md'), 'exam\n');
    // Mirrors the real repo: build output and dependencies are ignored, so
    // staging the candidate's work does not sweep them into the diff.
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
    // A package.json whose build and test are trivially controllable.
    writeFileSync(join(repo, 'package.json'), JSON.stringify({
      name: 'fake', scripts: { build: 'true', test: 'true' },
    }, null, 2));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'init');
  });

  const propose = (runAgent: (p: string, wt: string) => Promise<string | null>, over = {}) =>
    proposeImprovement(weakness, { repoRoot: repo, baseline, runAgent, ...over });

  it('rejects a candidate that edited the exam, before even building it', async () => {
    let built = false;
    const r = await propose(async (_p, wt) => {
      writeFileSync(join(wt, 'benchmarks', 'task.md'), 'easier exam\n');
      built = true;
      return null;
    });
    expect(r.verdict).toBe('rejected');
    expect(r.reason).toMatch(/exam/);
    expect(r.gates.diffAllowed).toBe(false);
    expect(r.gates.build).toBe(false); // never got that far
    expect(built).toBe(true);
  }, 30_000);

  it('rejects a candidate that ADDED a new benchmark task', async () => {
    // A plain `git diff` cannot see untracked files, so an easy new exam task
    // would have been invisible to the guard that exists to stop exactly this.
    const r = await propose(async (_p, wt) => {
      mkdirSync(join(wt, 'benchmarks', 'harness', 'trivially-easy'), { recursive: true });
      writeFileSync(join(wt, 'benchmarks', 'harness', 'trivially-easy', 'task.md'), 'do nothing\n');
      writeFileSync(join(wt, 'src', 'agent.ts'), 'export const x = 2;\n');
      return null;
    });
    expect(r.verdict).toBe('rejected');
    expect(r.reason).toMatch(/exam/);
  }, 30_000);

  it('leaves a reviewable commit on the branch, not just a dirty worktree', async () => {
    const r = await propose(async (_p, wt) => {
      writeFileSync(join(wt, 'src', 'agent.ts'), 'export const x = 2;\n');
      mkdirSync(join(wt, 'dist'), { recursive: true });
      writeFileSync(join(wt, 'dist', 'index.js'),
        `console.log(JSON.stringify(${JSON.stringify({ ...baseline, score: 100 })}));\n`);
      return null;
    });
    const diff = execFileSync('git', ['diff', `main...${r.branch}`, '--name-only'], { cwd: repo, encoding: 'utf-8' });
    expect(diff).toContain('src/agent.ts');
  }, 40_000);

  it('rejects a candidate that rewrote an existing test', async () => {
    const r = await propose(async (_p, wt) => {
      writeFileSync(join(wt, 'src', 'agent.ts'), 'export const x = 2;\n');
      writeFileSync(join(wt, 'test', 'a.test.ts'), '// weakened\n');
      return null;
    });
    expect(r.verdict).toBe('rejected');
    expect(r.reason).toMatch(/existing test/);
  }, 30_000);

  it('rejects a candidate that changed nothing', async () => {
    const r = await propose(async () => null);
    expect(r.verdict).toBe('rejected');
    expect(r.reason).toMatch(/changed nothing/);
  }, 30_000);

  it('rejects a candidate that does not build', async () => {
    const r = await propose(async (_p, wt) => {
      writeFileSync(join(wt, 'src', 'agent.ts'), 'export const x = 2;\n');
      writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'f', scripts: { build: 'exit 1', test: 'true' } }));
      return null;
    });
    expect(r.verdict).toBe('rejected');
    expect(r.reason).toMatch(/build failed/);
    expect(r.gates.tests).toBe(false);
  }, 30_000);

  it('rejects a candidate whose tests fail', async () => {
    const r = await propose(async (_p, wt) => {
      writeFileSync(join(wt, 'src', 'agent.ts'), 'export const x = 2;\n');
      writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'f', scripts: { build: 'true', test: 'exit 1' } }));
      return null;
    });
    expect(r.verdict).toBe('rejected');
    expect(r.reason).toMatch(/tests failed/);
    expect(r.gates.build).toBe(true);
  }, 30_000);

  it('rejects a passing candidate that did not move the number', async () => {
    // Passing the build and the tests is not evidence that a harness change
    // helped. Only the re-measurement is.
    const r = await propose(async (_p, wt) => {
      // `--eval --json` here just echoes a result with the same score.
      writeFileSync(join(wt, 'package.json'), JSON.stringify({
        name: 'f', scripts: { build: 'true', test: 'true' },
      }));
      writeFileSync(join(wt, 'src', 'agent.ts'), 'export const x = 2;\n');
      mkdirSync(join(wt, 'dist'), { recursive: true });
      writeFileSync(join(wt, 'dist', 'index.js'),
        `console.log(JSON.stringify(${JSON.stringify({ ...baseline, score: 50 })}));\n`);
      return null;
    });
    expect(r.verdict).toBe('rejected');
    expect(r.reason).toMatch(/no measurable improvement/);
    expect(r.candidateScore).toBe(50);
  }, 40_000);

  it('rejects a candidate that made the score worse', async () => {
    const r = await propose(async (_p, wt) => {
      writeFileSync(join(wt, 'src', 'agent.ts'), 'export const x = 2;\n');
      mkdirSync(join(wt, 'dist'), { recursive: true });
      writeFileSync(join(wt, 'dist', 'index.js'),
        `console.log(JSON.stringify(${JSON.stringify({ ...baseline, score: 0 })}));\n`);
      return null;
    });
    expect(r.verdict).toBe('rejected');
    expect(r.reason).toMatch(/dropped 50% → 0%/);
  }, 40_000);

  it('proposes a candidate that passed every gate and improved the score', async () => {
    const r = await propose(async (_p, wt) => {
      writeFileSync(join(wt, 'src', 'agent.ts'), 'export const x = 2;\n');
      writeFileSync(join(wt, 'test', 'new.test.ts'), 'export {};\n');
      mkdirSync(join(wt, 'dist'), { recursive: true });
      writeFileSync(join(wt, 'dist', 'index.js'),
        `console.log(JSON.stringify(${JSON.stringify({ ...baseline, score: 100 })}));\n`);
      return null;
    });
    expect(r.verdict).toBe('proposed');
    expect(r.reason).toBe('50% → 100%');
    expect(r.gates).toEqual({ build: true, tests: true, diffAllowed: true, improved: true });
    expect(r.changedFiles.map((f) => f.path).sort()).toEqual(['src/agent.ts', 'test/new.test.ts']);
    expect(r.diffStat).toContain('src/agent.ts');
  }, 40_000);

  it('reports an agent that could not run instead of throwing', async () => {
    const r = await propose(async () => { throw new Error('ECONNREFUSED 10.0.154.246:8000'); });
    expect(r.verdict).toBe('rejected');
    expect(r.reason).toMatch(/could not run/);
    expect(r.reason).toContain('ECONNREFUSED');
  }, 30_000);

  it('refuses to judge a candidate with no baseline to compare against', async () => {
    const r = await propose(
      async (_p, wt) => { writeFileSync(join(wt, 'src', 'agent.ts'), 'export const x = 2;\n'); return null; },
      { baseline: null },
    );
    expect(r.verdict).toBe('rejected');
    expect(r.reason).toMatch(/no baseline/);
  }, 30_000);

  it('leaves the worktree behind so a rejected attempt can be inspected', async () => {
    const r = await propose(async (_p, wt) => {
      writeFileSync(join(wt, 'src', 'agent.ts'), 'export const x = 2;\n');
      writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'f', scripts: { build: 'exit 1', test: 'true' } }));
      return null;
    });
    expect(existsSync(r.worktreePath)).toBe(true);
    expect(existsSync(join(r.worktreePath, 'src', 'agent.ts'))).toBe(true);
  }, 30_000);
});

describe('reporting', () => {
  const base: ImprovementRun = {
    at: '2026-07-29T12:00:00.000Z',
    weakness: { kind: 'failing_task', severity: 60, title: 'beta fails', evidence: '12 calls', brief: 'b' },
    branch: 'veepee/improve-failing-task-ab12',
    worktreePath: '/repo/.veepee-worktrees/x',
    baselineScore: 50, candidateScore: 100,
    gates: { build: true, tests: true, diffAllowed: true, improved: true },
    verdict: 'proposed', reason: '50% → 100%',
    changedFiles: [{ status: 'M', path: 'src/agent.ts' }],
    diffStat: ' src/agent.ts | 4 ++--',
  };

  it('makes the review command copy-pasteable and says nothing shipped', () => {
    const md = formatImprovementReport(base);
    expect(md).toContain('git diff main...veepee/improve-failing-task-ab12');
    expect(md).toMatch(/Nothing has been merged, pushed, or deployed/);
    expect(md).toContain('50% → 100%');
  });

  it('shows which gate stopped a rejected candidate', () => {
    const md = formatImprovementReport({
      ...base, verdict: 'rejected', reason: 'build failed',
      gates: { build: false, tests: false, diffAllowed: true, improved: false },
    });
    expect(md).toContain('REJECTED');
    expect(md).toMatch(/\| build \| FAIL \|/);
    expect(md).toMatch(/\| diff stayed out of the exam \| pass \|/);
  });

  it('writes the report where it can be found later', async () => {
    const p = await saveImprovementReport(base, tmp);
    expect(p).toContain('proposed');
    expect(readFileSync(p, 'utf-8')).toContain('beta fails');
  });
});
