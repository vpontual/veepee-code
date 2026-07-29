import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadHarnessTasks, compareRuns, saveEvalResult, groupToolErrors, errorSignature, aggregateRuns, type HarnessEvalResult, type HarnessTaskResult } from '../src/harness-eval.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vcode-heval-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function task(name: string, extra: Record<string, string> = {}, meta?: object): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  writeFileSync(join(dir, 'task.md'), `do the thing for ${name}\n`);
  writeFileSync(join(dir, 'verify.test.ts'), 'export {};');
  writeFileSync(join(dir, 'workspace', 'index.ts'), 'export const x = 1;');
  if (meta) writeFileSync(join(dir, 'metadata.json'), JSON.stringify(meta));
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(dir, f), c);
  return dir;
}

describe('loadHarnessTasks', () => {
  it('loads a well-formed task', async () => {
    task('alpha', {}, { tags: ['debug'], timeout_ms: 1234 });
    const tasks = await loadHarnessTasks(tmp);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('alpha');
    expect(tasks[0].prompt).toBe('do the thing for alpha');
    expect(tasks[0].tags).toEqual(['debug']);
    expect(tasks[0].timeoutMs).toBe(1234);
  });

  it('skips directories missing any required part', async () => {
    // A half-written task must be ignored rather than scored as a failure —
    // otherwise the suite silently reports a regression that is really a typo.
    const incomplete = join(tmp, 'no-verify');
    mkdirSync(join(incomplete, 'workspace'), { recursive: true });
    writeFileSync(join(incomplete, 'task.md'), 'x');
    task('complete');

    const names = (await loadHarnessTasks(tmp)).map((t) => t.name);
    expect(names).toEqual(['complete']);
  });

  it('falls back to defaults when metadata is absent or malformed', async () => {
    task('nometa');
    task('badmeta', { 'metadata.json': '{ not json' });
    const tasks = await loadHarnessTasks(tmp);
    for (const t of tasks) {
      expect(t.tags).toEqual([]);
      expect(t.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('returns an empty list for a missing directory', async () => {
    expect(await loadHarnessTasks(join(tmp, 'nope'))).toEqual([]);
  });

  it('sorts by name so runs are ordered consistently', async () => {
    task('zebra'); task('alpha'); task('mid');
    expect((await loadHarnessTasks(tmp)).map((t) => t.name)).toEqual(['alpha', 'mid', 'zebra']);
  });
});

describe('tool error grouping', () => {
  it('collapses the same failure with different paths into one group', () => {
    // Otherwise ten instances of one bug read as ten separate problems and
    // crowd out the others.
    const groups = groupToolErrors([
      { tool: 'read_file', error: "File not found: '/tmp/a/src/x.ts'" },
      { tool: 'read_file', error: "File not found: '/tmp/b/src/y.ts'" },
      { tool: 'read_file', error: "File not found: '/tmp/c/src/z.ts'" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].tool).toBe('read_file');
  });

  it('keeps genuinely different failures apart', () => {
    const groups = groupToolErrors([
      { tool: 'read_file', error: 'File not found' },
      { tool: 'edit_file', error: 'String not found in file' },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('separates the same message coming from different tools', () => {
    const groups = groupToolErrors([
      { tool: 'read_file', error: 'File not found' },
      { tool: 'write_file', error: 'File not found' },
    ]);
    expect(groups.map((g) => g.tool).sort()).toEqual(['read_file', 'write_file']);
  });

  it('puts the most frequent failure first and caps the list', () => {
    const errors = [
      ...Array.from({ length: 5 }, () => ({ tool: 'bash', error: 'Exit code 1' })),
      ...Array.from({ length: 9 }, (_, i) => ({ tool: `t${i}`, error: `distinct ${i}` })),
    ];
    const groups = groupToolErrors(errors, 3);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ tool: 'bash', count: 5 });
  });

  it('normalises line numbers and quoted names but not the wording', () => {
    expect(errorSignature("Cannot find 'foo' at line 42"))
      .toBe(errorSignature("Cannot find 'bar' at line 7"));
    expect(errorSignature('Cannot find it')).not.toBe(errorSignature('Permission denied'));
  });

  it('survives an empty error message', () => {
    expect(groupToolErrors([{ tool: 'bash', error: '' }])[0].count).toBe(1);
  });

  it('returns nothing when no tool failed', () => {
    expect(groupToolErrors([])).toEqual([]);
  });
});

describe('aggregateRuns', () => {
  const r = (over: Partial<HarnessTaskResult> = {}): HarnessTaskResult => ({
    task: 't', passed: true, runs: 1, passes: 1, detail: '', tags: [], turns: 2,
    toolCalls: 10, toolErrors: 0, selfVerified: true, wallMs: 1000, model: 'm',
    ...over,
  });

  it('reports how many of the runs passed', () => {
    const agg = aggregateRuns([r(), r({ passed: false, passes: 0 }), r()]);
    expect(agg.runs).toBe(3);
    expect(agg.passes).toBe(2);
  });

  it('marks the task passed only when every run passed', () => {
    // A task that passes 2 of 3 is not a passing task — that intermittency is
    // exactly what a single-sample score hides.
    expect(aggregateRuns([r(), r({ passes: 0, passed: false })]).passed).toBe(false);
    expect(aggregateRuns([r(), r()]).passed).toBe(true);
  });

  it('averages the metrics rather than keeping one arbitrary run', () => {
    const agg = aggregateRuns([r({ toolCalls: 10, wallMs: 1000 }), r({ toolCalls: 20, wallMs: 3000 })]);
    expect(agg.toolCalls).toBe(15);
    expect(agg.wallMs).toBe(2000);
  });

  it('keeps the detail of the first failing run, not of a passing one', () => {
    const agg = aggregateRuns([r(), r({ passes: 0, passed: false, detail: 'expected 1 to be 2' })]);
    expect(agg.detail).toBe('expected 1 to be 2');
  });

  it('merges tool errors across runs so an intermittent one is not lost', () => {
    // Without merging, a failure seen only in the run that happened to pass
    // disappears from the report entirely.
    const agg = aggregateRuns([
      r({ toolErrorDetail: [{ tool: 'edit_file', error: 'not found', count: 2 }] }),
      r({ toolErrorDetail: [{ tool: 'edit_file', error: 'not found', count: 1 }] }),
    ]);
    expect(agg.toolErrorDetail).toEqual([{ tool: 'edit_file', error: 'not found', count: 3 }]);
  });

  it('only claims self-verification when it happened every time', () => {
    expect(aggregateRuns([r({ selfVerified: true }), r({ selfVerified: false })]).selfVerified).toBe(false);
  });

  it('is a no-op for a single run', () => {
    const one = r({ toolCalls: 7 });
    const agg = aggregateRuns([one]);
    expect(agg.runs).toBe(1);
    expect(agg.passes).toBe(1);
    expect(agg.toolCalls).toBe(7);
  });
});

describe('compareRuns', () => {
  const run = (commit: string, results: Array<[string, boolean]>): HarnessEvalResult => ({
    at: '2026-07-29T00:00:00.000Z',
    model: 'test-model',
    commit,
    passed: results.filter(([, p]) => p).length,
    total: results.length,
    score: Math.round((results.filter(([, p]) => p).length / results.length) * 100),
    results: results.map(([task, passed]) => ({
      task, passed, runs: 1, passes: passed ? 1 : 0, detail: '', tags: [], turns: 1, toolCalls: 1,
      toolErrors: 0, selfVerified: false, wallMs: 1, model: 'test-model',
    })),
  });

  it('reports the score movement between two commits', () => {
    const out = compareRuns(run('aaa', [['t1', false], ['t2', true]]), run('bbb', [['t1', true], ['t2', true]]));
    expect(out).toContain('aaa → bbb');
    expect(out).toContain('50% → 100%');
  });

  it('names the task that a change fixed', () => {
    const out = compareRuns(run('aaa', [['t1', false]]), run('bbb', [['t1', true]]));
    expect(out).toContain('FIXED');
    expect(out).toContain('t1');
  });

  it('names the task that a change broke — the point of keeping history', () => {
    const out = compareRuns(run('aaa', [['t1', true]]), run('bbb', [['t1', false]]));
    expect(out).toContain('BROKE');
    expect(out).toContain('t1');
  });

  it('marks a newly added task rather than treating it as a regression', () => {
    const out = compareRuns(run('aaa', [['t1', true]]), run('bbb', [['t1', true], ['t2', false]]));
    expect(out).toContain('+ t2');
  });

  it('stays quiet about tasks whose outcome did not change', () => {
    const out = compareRuns(run('aaa', [['t1', true], ['t2', false]]), run('bbb', [['t1', true], ['t2', false]]));
    expect(out).not.toContain('FIXED');
    expect(out).not.toContain('BROKE');
  });
});

describe('saveEvalResult', () => {
  it('writes a result keyed by timestamp and commit so runs are comparable', async () => {
    const result: HarnessEvalResult = {
      at: '2026-07-29T12:34:56.789Z', model: 'm', commit: 'abc1234',
      passed: 1, total: 2, score: 50, results: [],
    };
    const path = await saveEvalResult(result, tmp);
    expect(path).toContain('abc1234');
    expect(JSON.parse(readFileSync(path, 'utf-8')).score).toBe(50);
  });
});
