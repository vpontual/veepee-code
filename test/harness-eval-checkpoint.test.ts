import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { checkpointPath, loadCheckpoint, artifactHash } from '../src/harness-eval.js';

/**
 * The suite wrote nothing until all 15 tasks finished, so a process death at
 * task 7 destroyed six completed tasks — thirty model runs, ~25 minutes — with
 * no trace. That happened on 2026-08-23, and the results survived only because
 * the log was being tailed.
 */
let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

describe('eval checkpointing', () => {
  it('names a partial per key, inside the evals directory', () => {
    const p = checkpointPath('abc123-r5', '/tmp/evals');
    expect(p).toBe(join('/tmp/evals', '.partial-abc123-r5.json'));
  });

  it('returns null when there is no checkpoint', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vcode-ckpt-'));
    expect(await loadCheckpoint('nothing-here', dir)).toBeNull();
  });

  it('reads back a checkpoint it can parse', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vcode-ckpt-'));
    const cp = {
      key: 'k', artifact: 'deadbeef', model: 'm', commit: 'c', repeat: 5,
      startedAt: '2026-08-23T00:00:00.000Z',
      results: [{ task: 'one', passed: true, runs: 5, passes: 5 }],
    };
    await writeFile(checkpointPath('k', dir), JSON.stringify(cp));
    const back = await loadCheckpoint('k', dir);
    expect(back?.results).toHaveLength(1);
    expect(back?.artifact).toBe('deadbeef');
  });

  it('survives a corrupt checkpoint rather than throwing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vcode-ckpt-'));
    await writeFile(checkpointPath('k', dir), '{ this is not json');
    expect(await loadCheckpoint('k', dir)).toBeNull();
  });

  it('identifies the artifact by content, so a resume cannot mix two builds', async () => {
    // Mixing results from two builds into one score is not a measurement of
    // either — the resume path compares this hash and refuses on mismatch.
    const a = artifactHash();
    expect(a).toMatch(/^[0-9a-f]{12}$|^no-dist$|^unreadable$/);
    expect(artifactHash()).toBe(a); // stable for an unchanged file
  });

  it('keeps the checkpoint out of the results listing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vcode-ckpt-'));
    await writeFile(checkpointPath('k', dir), '{}');
    // Dotfile prefix: `listSessions`-style scans and the evals listing both
    // read `*.json`, and a partial is not a run.
    expect(existsSync(join(dir, '.partial-k.json'))).toBe(true);
    const content = await readFile(join(dir, '.partial-k.json'), 'utf-8');
    expect(content).toBe('{}');
  });
});
