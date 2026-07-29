import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadHarnessTasks, compareRuns, saveEvalResult, type HarnessEvalResult } from '../src/harness-eval.js';

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

describe('compareRuns', () => {
  const run = (commit: string, results: Array<[string, boolean]>): HarnessEvalResult => ({
    at: '2026-07-29T00:00:00.000Z',
    model: 'test-model',
    commit,
    passed: results.filter(([, p]) => p).length,
    total: results.length,
    score: Math.round((results.filter(([, p]) => p).length / results.length) * 100),
    results: results.map(([task, passed]) => ({
      task, passed, detail: '', tags: [], turns: 1, toolCalls: 1,
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
