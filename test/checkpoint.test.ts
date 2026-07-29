import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { CheckpointManager } from '../src/checkpoint.js';

let tmp: string;
let proj: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vcode-cp-'));
  proj = join(tmp, 'project');
  mkdirSync(proj, { recursive: true });
  prevHome = process.env.HOME;
  // Shadow repos live under $HOME/.veepee-code/checkpoints — isolate them.
  process.env.HOME = join(tmp, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

const write = (rel: string, content: string) => {
  const p = join(proj, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
};
const read = (rel: string) => readFileSync(join(proj, rel), 'utf-8');
const has = (rel: string) => existsSync(join(proj, rel));

describe('CheckpointManager', () => {
  it('captures and restores a simple edit', async () => {
    write('a.txt', 'v1');
    const cm = new CheckpointManager(proj);
    const c1 = await cm.snapshot('first');
    expect(c1).not.toBeNull();

    write('a.txt', 'v2');
    await cm.snapshot('second');

    const res = await cm.restore(c1!.id);
    expect(res.ok).toBe(true);
    expect(read('a.txt')).toBe('v1');
  });

  it('captures edits made by the SHELL, not just by the edit tools', async () => {
    // This is the whole reason for snapshotting the working tree. Per-tool undo
    // systems record what write/edit did and are blind to `sed -i`, formatters,
    // codegen and `mv` — which for a coding agent is most of what happens.
    write('a.txt', 'original value');
    const cm = new CheckpointManager(proj);
    const c1 = await cm.snapshot('before shell edit');

    execFileSync('sed', ['-i', 's/original/replaced/', 'a.txt'], { cwd: proj });
    expect(read('a.txt')).toBe('replaced value');

    await cm.restore(c1!.id);
    expect(read('a.txt')).toBe('original value');
  });

  it('deletes files created since the checkpoint', async () => {
    write('keep.txt', 'keep');
    const cm = new CheckpointManager(proj);
    const c1 = await cm.snapshot('before');

    write('src/new.ts', 'export const y = 2;');
    await cm.restore(c1!.id);

    // checkout-index restores what IS in the tree but leaves newer files
    // behind, so a rewind that only did that would be half done.
    expect(has('src/new.ts')).toBe(false);
    expect(read('keep.txt')).toBe('keep');
  });

  it('restores files deleted since the checkpoint', async () => {
    write('gone.txt', 'important');
    const cm = new CheckpointManager(proj);
    const c1 = await cm.snapshot('before');

    execFileSync('rm', ['gone.txt'], { cwd: proj });
    expect(has('gone.txt')).toBe(false);

    await cm.restore(c1!.id);
    expect(read('gone.txt')).toBe('important');
  });

  it('honours .gitignore so build output and deps cost nothing', async () => {
    write('.gitignore', 'ignored.log\nnode_modules/\n');
    write('ignored.log', 'noise');
    write('node_modules/pkg/index.js', 'module.exports = 1;');
    write('src.ts', 'v1');

    const cm = new CheckpointManager(proj);
    const c1 = await cm.snapshot('before');
    write('src.ts', 'v2');
    write('ignored.log', 'more noise');

    await cm.restore(c1!.id);
    expect(read('src.ts')).toBe('v1');
    // Ignored files are neither snapshotted nor clobbered by a restore.
    expect(read('ignored.log')).toBe('more noise');
    expect(has('node_modules/pkg/index.js')).toBe(true);
  });

  it('skips a snapshot when nothing changed', async () => {
    write('a.txt', 'same');
    const cm = new CheckpointManager(proj);
    expect(await cm.snapshot('first')).not.toBeNull();
    // Read-only turns are the common case; they must not fill the list.
    expect(await cm.snapshot('no change')).toBeNull();
    expect(cm.list()).toHaveLength(1);
  });

  it('makes a rewind itself undoable', async () => {
    write('a.txt', 'v1');
    const cm = new CheckpointManager(proj);
    const c1 = await cm.snapshot('v1');
    write('a.txt', 'v2');
    await cm.snapshot('v2');

    const undo = await cm.restore(c1!.id);
    expect(undo.ok && undo.undoId).toBeTruthy();
    expect(read('a.txt')).toBe('v1');

    const redo = await cm.restore((undo as { undoId: string }).undoId);
    expect(redo.ok).toBe(true);
    expect(read('a.txt')).toBe('v2');
  });

  it('previews a restore without changing anything', async () => {
    write('a.txt', 'v1');
    const cm = new CheckpointManager(proj);
    const c1 = await cm.snapshot('v1');
    write('a.txt', 'v2');
    write('added.txt', 'new');

    const pv = await cm.previewRestore(c1!.id);
    expect(pv.ok).toBe(true);
    if (pv.ok) {
      expect(pv.summary).toContain('revert   a.txt');
      expect(pv.summary).toContain('delete   added.txt');
      expect(pv.files).toBe(2);
    }
    // Nothing actually moved.
    expect(read('a.txt')).toBe('v2');
    expect(has('added.txt')).toBe(true);
  });

  it('reports an unknown checkpoint instead of throwing', async () => {
    const cm = new CheckpointManager(proj);
    write('a.txt', 'x');
    await cm.snapshot('x');
    const res = await cm.restore('deadbeef');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/No checkpoint/);
  });

  it('never touches the project\'s own git repository', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: proj });
    write('a.txt', 'v1');
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: proj });
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: proj, encoding: 'utf-8' }).trim();

    const cm = new CheckpointManager(proj);
    const c1 = await cm.snapshot('before');
    write('a.txt', 'v2');
    await cm.snapshot('after');
    await cm.restore(c1!.id);

    // Same HEAD, and the user's index/worktree state is theirs alone.
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: proj, encoding: 'utf-8' }).trim();
    expect(headAfter).toBe(headBefore);
    const reflog = execFileSync('git', ['reflog'], { cwd: proj, encoding: 'utf-8' });
    expect(reflog.split('\n').filter(Boolean)).toHaveLength(1); // just the initial commit
  });

  it('works in a project that is not a git repository at all', async () => {
    write('a.txt', 'v1');
    const cm = new CheckpointManager(proj);
    const c1 = await cm.snapshot('v1');
    expect(c1).not.toBeNull();
    write('a.txt', 'v2');
    await cm.restore(c1!.id);
    expect(read('a.txt')).toBe('v1');
  });

  it('persists checkpoints across manager instances', async () => {
    write('a.txt', 'v1');
    const cm1 = new CheckpointManager(proj);
    const c1 = await cm1.snapshot('v1');
    write('a.txt', 'v2');
    await cm1.snapshot('v2');

    // A new session in the same project must still be able to rewind.
    const cm2 = new CheckpointManager(proj);
    await cm2.init();
    expect(cm2.list().length).toBe(2);
    const res = await cm2.restore(c1!.id);
    expect(res.ok).toBe(true);
    expect(read('a.txt')).toBe('v1');
  });
});
