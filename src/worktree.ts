import { execFileSync } from 'child_process';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, rmSync, readFileSync, appendFileSync } from 'fs';
import { randomBytes } from 'crypto';

// ─── Git Worktree Manager ────────────────────────────────────────────────────

/**
 * Manages git worktrees for isolated agent task execution.
 * Allows running experiments without touching the user's working tree.
 */

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch: string;
  created: Date;
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
    // Add to .gitignore if not already there
    try {
      const gitignorePath = resolve(cwd, '.gitignore');
      if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, 'utf-8');
        if (!content.includes(WORKTREE_DIR)) {
          appendFileSync(gitignorePath, `\n${WORKTREE_DIR}/\n`);
        }
      }
    } catch { /* non-critical */ }
  }

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
          worktrees.push({
            path: currentPath,
            branch: currentBranch,
            baseBranch: getCurrentBranch(cwd),
            created: new Date(),
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
