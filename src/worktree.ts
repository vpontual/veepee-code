import { execFileSync } from 'child_process';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, rmSync, readFileSync, appendFileSync, statSync } from 'fs';
import { randomBytes } from 'crypto';

// ─── Git Worktree Manager ────────────────────────────────────────────────────

/**
 * Manages git worktrees for isolated agent task execution.
 * Allows running experiments without touching the user's working tree.
 */

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** Branch this worktree was created from, when known. `git worktree list`
   *  does not report it, so it is null for entries discovered by listing. */
  baseBranch: string | null;
  /** Creation time, or null when it cannot be determined. */
  created: Date | null;
}

const WORKTREE_DIR = '.veepee-worktrees';

/** Check if cwd is a git repository */
export function isGitRepo(cwd: string = process.cwd()): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Get current git branch name */
export function getCurrentBranch(cwd: string = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
  } catch {
    return 'main';
  }
}

/** Create an isolated git worktree for agent work */
export function createWorktree(
  taskName?: string,
  cwd: string = process.cwd(),
): WorktreeInfo {
  if (!isGitRepo(cwd)) {
    throw new Error('Not a git repository — worktrees require git');
  }

  const baseBranch = getCurrentBranch(cwd);
  const suffix = randomBytes(4).toString('hex');
  const branchName = `veepee/${taskName ? slugify(taskName) : 'task'}-${suffix}`;

  // Create worktree directory
  const worktreeBase = resolve(cwd, WORKTREE_DIR);
  if (!existsSync(worktreeBase)) {
    mkdirSync(worktreeBase, { recursive: true });
  }
  // Ignore the worktree tree. This used to run only when the base directory
  // was newly created AND a .gitignore already existed, so a repo without one
  // — or one where the directory already existed — was left showing the
  // worktrees as untracked files forever.
  try {
    const gitignorePath = resolve(cwd, '.gitignore');
    const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
    if (!content.includes(WORKTREE_DIR)) {
      const prefix = content && !content.endsWith('\n') ? '\n' : '';
      appendFileSync(gitignorePath, `${prefix}${WORKTREE_DIR}/\n`);
    }
  } catch { /* non-critical */ }

  const worktreePath = resolve(worktreeBase, branchName.replace(/\//g, '-'));

  // Create the worktree with a new branch
  execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath], {
    cwd, encoding: 'utf-8', stdio: 'pipe',
  });

  return {
    path: worktreePath,
    branch: branchName,
    baseBranch,
    created: new Date(),
  };
}

/** List all active veepee worktrees */
export function listWorktrees(cwd: string = process.cwd()): WorktreeInfo[] {
  if (!isGitRepo(cwd)) return [];

  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd, encoding: 'utf-8', stdio: 'pipe',
    });

    const worktrees: WorktreeInfo[] = [];
    let currentPath = '';
    let currentBranch = '';

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice(9);
      } else if (line.startsWith('branch refs/heads/')) {
        currentBranch = line.slice(18);
        if (currentBranch.startsWith('veepee/')) {
          // baseBranch and created are NOT recoverable from `git worktree
          // list`. They used to be filled in with the caller's current branch
          // and the current time, which reported confident nonsense — every
          // worktree looked like it branched from wherever you happen to be
          // standing and was created this instant. Derive `created` from the
          // directory's own mtime and leave the base branch unknown.
          let created: Date | null = null;
          try { created = statSync(currentPath).birthtime ?? statSync(currentPath).mtime; } catch { /* gone */ }
          worktrees.push({
            path: currentPath,
            branch: currentBranch,
            baseBranch: null,
            created,
          });
        }
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

/** Remove a worktree and its branch */
export function removeWorktree(worktreePath: string, cwd: string = process.cwd()): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd, encoding: 'utf-8', stdio: 'pipe',
    });
  } catch { /* may already be removed */ }

  // Clean up directory if still exists
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

/** Remove all veepee worktrees */
export function cleanupWorktrees(cwd: string = process.cwd()): number {
  const worktrees = listWorktrees(cwd);
  for (const wt of worktrees) {
    removeWorktree(wt.path, cwd);
    // Also delete the branch
    try {
      execFileSync('git', ['branch', '-D', wt.branch], {
        cwd, encoding: 'utf-8', stdio: 'pipe',
      });
    } catch { /* branch may not exist */ }
  }
  return worktrees.length;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
