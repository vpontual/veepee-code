/**
 * File checkpointing — snapshot the working tree so an agent turn can be undone.
 *
 * Conversation history is already rewindable (`/tree`), but that only moves the
 * transcript: the files an agent wrote stay written. This closes that gap.
 *
 * ## Why a shadow git repo
 *
 * The alternative — recording per-tool undo entries as the write/edit tools run
 * — only sees edits made *through those tools*. Every implementation that works
 * that way documents the same hole: changes made by shell commands
 * (`sed -i`, `npm run format`, a codegen script, `mv`) are invisible to it.
 * For an agent whose whole job is running builds and scripts, that hole is most
 * of the surface area.
 *
 * Snapshotting the actual working tree has no such blind spot. It captures
 * whatever is on disk regardless of what put it there.
 *
 * The shadow repo lives outside the project, with its own GIT_DIR and the
 * project passed as --work-tree, so the user's real `.git` — index, HEAD,
 * reflog, stash — is never touched. It is not a branch, not a stash, and not
 * visible to `git log`. `git add -A` still honours the project's .gitignore, so
 * node_modules and build output cost nothing.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { writeFileAtomicSync } from './atomic-write.js';

const exec = promisify(execFile);

export interface Checkpoint {
  /** Short identifier shown to the user (first 8 of the tree sha). */
  id: string;
  /** Git tree object capturing the whole working tree at this moment. */
  tree: string;
  /** What the agent was asked to do when this snapshot was taken. */
  label: string;
  /** ISO timestamp. */
  at: string;
}

/** Never snapshot these, regardless of the project's .gitignore. */
const ALWAYS_EXCLUDE = [
  '.git/',
  'node_modules/',
  '.veepee-worktrees/',
  '*.tmp-*',
];

/** Cap on retained checkpoints. Tree objects are cheap (git dedupes blobs),
 *  but the index file should not grow without bound. */
const MAX_CHECKPOINTS = 100;

function shadowDirFor(projectDir: string): string {
  // Hash the path so two projects with the same basename don't collide, and
  // keep a readable prefix so the directory is identifiable by eye.
  const abs = resolve(projectDir);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 12);
  const base = abs.split('/').filter(Boolean).pop() || 'project';
  return resolve(process.env.HOME || '~', '.veepee-code', 'checkpoints', `${base}-${hash}`);
}

export class CheckpointManager {
  private projectDir: string;
  private gitDir: string;
  private indexPath: string;
  private checkpoints: Checkpoint[] = [];
  private ready = false;
  /** Set once init() fails, so we stop retrying git on every turn. */
  private disabledReason: string | null = null;

  constructor(projectDir: string = process.cwd()) {
    this.projectDir = resolve(projectDir);
    this.gitDir = shadowDirFor(this.projectDir);
    this.indexPath = join(this.gitDir, 'veepee-checkpoints.json');
  }

  /** Why checkpointing is unavailable, or null when it is working. */
  unavailableReason(): string | null {
    return this.disabledReason;
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return exec('git', ['--git-dir', this.gitDir, '--work-tree', this.projectDir, ...args], {
      cwd: this.projectDir,
      maxBuffer: 64 * 1024 * 1024,
      // The shadow repo must never pick up the user's identity or hooks.
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  }

  /** Create the shadow repo if needed. Safe to call repeatedly. */
  async init(): Promise<boolean> {
    if (this.ready) return true;
    if (this.disabledReason) return false;
    try {
      if (!existsSync(this.gitDir)) {
        mkdirSync(this.gitDir, { recursive: true });
        await exec('git', ['init', '--bare', '--quiet', this.gitDir]);
      }
      // Our own excludes, on top of whatever the project's .gitignore says.
      const infoDir = join(this.gitDir, 'info');
      if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
      writeFileSync(join(infoDir, 'exclude'), ALWAYS_EXCLUDE.join('\n') + '\n');

      if (existsSync(this.indexPath)) {
        try {
          this.checkpoints = JSON.parse(readFileSync(this.indexPath, 'utf-8')) as Checkpoint[];
        } catch {
          this.checkpoints = [];
        }
      }
      this.ready = true;
      return true;
    } catch (err) {
      this.disabledReason = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  private persist(): void {
    try {
      writeFileAtomicSync(this.indexPath, JSON.stringify(this.checkpoints, null, 2));
    } catch { /* non-critical */ }
  }

  /**
   * Capture the working tree.
   *
   * Returns null when nothing changed since the previous checkpoint — read-only
   * turns are the common case and should not fill the list with identical
   * entries. Also returns null when checkpointing is unavailable; callers treat
   * this as best-effort and never block the agent on it.
   */
  async snapshot(label: string): Promise<Checkpoint | null> {
    if (!(await this.init())) return null;
    try {
      await this.git(['add', '-A']);
      const { stdout } = await this.git(['write-tree']);
      const tree = stdout.trim();
      if (!tree) return null;

      const previous = this.checkpoints[this.checkpoints.length - 1];
      if (previous?.tree === tree) return null;

      const cp: Checkpoint = {
        id: tree.slice(0, 8),
        tree,
        label: label.replace(/\s+/g, ' ').trim().slice(0, 120),
        at: new Date().toISOString(),
      };
      this.checkpoints.push(cp);
      if (this.checkpoints.length > MAX_CHECKPOINTS) {
        this.checkpoints.splice(0, this.checkpoints.length - MAX_CHECKPOINTS);
      }
      this.persist();
      return cp;
    } catch {
      // A snapshot failure must never break the turn.
      return null;
    }
  }

  /** Most recent first. */
  list(): Checkpoint[] {
    return [...this.checkpoints].reverse();
  }

  find(id: string): Checkpoint | null {
    return this.checkpoints.find((c) => c.id === id || c.tree.startsWith(id)) ?? null;
  }

  /** Human-readable summary of what restoring `id` would change. */
  async previewRestore(id: string): Promise<{ ok: true; summary: string; files: number } | { ok: false; error: string }> {
    const cp = this.find(id);
    if (!cp) return { ok: false, error: `No checkpoint ${id}` };
    if (!(await this.init())) return { ok: false, error: this.disabledReason ?? 'checkpointing unavailable' };
    try {
      await this.git(['add', '-A']);
      const { stdout: nowTree } = await this.git(['write-tree']);
      const { stdout } = await this.git(['diff', '--name-status', cp.tree, nowTree.trim()]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return { ok: true, summary: '(working tree already matches this checkpoint)', files: 0 };
      // Invert the letters: we are going BACK, so a file added since the
      // checkpoint will be deleted, and one deleted since will be restored.
      const rendered = lines.map((l) => {
        const [status, ...rest] = l.split('\t');
        const path = rest.join('\t');
        if (status.startsWith('A')) return `  delete   ${path}`;
        if (status.startsWith('D')) return `  restore  ${path}`;
        return `  revert   ${path}`;
      });
      return { ok: true, summary: rendered.join('\n'), files: lines.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Restore the working tree to a checkpoint.
   *
   * Always snapshots the current state first, so a rewind is itself undoable —
   * the returned `undoId` is the checkpoint representing "before this restore".
   */
  async restore(id: string): Promise<
    { ok: true; changed: number; undoId: string | null } | { ok: false; error: string }
  > {
    const cp = this.find(id);
    if (!cp) return { ok: false, error: `No checkpoint ${id}` };
    if (!(await this.init())) return { ok: false, error: this.disabledReason ?? 'checkpointing unavailable' };

    try {
      // 1. Snapshot where we are, so this is reversible. snapshot() returns
      //    null when the tree is unchanged since the last checkpoint — that is
      //    not a failure, it means the current state IS the newest checkpoint,
      //    which is exactly what an undo should target.
      const taken = await this.snapshot(`before rewind to ${cp.id}`);
      const before = taken ?? this.checkpoints[this.checkpoints.length - 1] ?? null;

      // 2. Work out what exists now that did not exist at the checkpoint.
      //    checkout-index restores files that ARE in the tree but will happily
      //    leave behind anything created since, so those must be removed
      //    explicitly or the rewind is only half done.
      await this.git(['add', '-A']);
      const { stdout: nowTreeRaw } = await this.git(['write-tree']);
      const { stdout: diff } = await this.git(['diff', '--name-status', cp.tree, nowTreeRaw.trim()]);
      const addedSince = diff
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('A'))
        .map((l) => l.split('\t').slice(1).join('\t'))
        .filter(Boolean);

      // 3. Put the checkpoint's tree into the index and write it to disk.
      await this.git(['read-tree', cp.tree]);
      await this.git(['checkout-index', '-a', '-f']);

      // 4. Remove the files that the checkpoint did not have.
      const { rm } = await import('fs/promises');
      for (const rel of addedSince) {
        await rm(join(this.projectDir, rel), { force: true }).catch(() => undefined);
      }

      const changed = diff.trim() ? diff.trim().split('\n').length : 0;
      return { ok: true, changed, undoId: before?.id ?? null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
