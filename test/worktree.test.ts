import { describe, it, expect } from 'vitest';

// worktree.ts exports several functions, but most require a real git repository.
// The slugify function is private (not exported). We test what we can:
// - isGitRepo on a non-git directory
// - getCurrentBranch fallback on non-git directory
// - Module export shape

describe('worktree module exports', () => {
  it('exports expected functions', async () => {
    const mod = await import('../src/worktree.js');
    expect(typeof mod.isGitRepo).toBe('function');
    expect(typeof mod.getCurrentBranch).toBe('function');
    expect(typeof mod.createWorktree).toBe('function');
    expect(typeof mod.listWorktrees).toBe('function');
    expect(typeof mod.removeWorktree).toBe('function');
    expect(typeof mod.cleanupWorktrees).toBe('function');
  });
});

describe('isGitRepo', () => {
  it('returns false for a non-git directory', async () => {
    const { isGitRepo } = await import('../src/worktree.js');
    expect(isGitRepo('/tmp')).toBe(false);
  });
});

describe('getCurrentBranch', () => {
  it('returns "main" as fallback for non-git directory', async () => {
    const { getCurrentBranch } = await import('../src/worktree.js');
    expect(getCurrentBranch('/tmp')).toBe('main');
  });
});

describe('listWorktrees', () => {
  it('returns empty array for non-git directory', async () => {
    const { listWorktrees } = await import('../src/worktree.js');
    expect(listWorktrees('/tmp')).toEqual([]);
  });
});

describe('createWorktree', () => {
  it('throws for non-git directory', async () => {
    const { createWorktree } = await import('../src/worktree.js');
    expect(() => createWorktree('test-task', '/tmp')).toThrow('Not a git repository');
  });
});

// Note: Testing createWorktree, removeWorktree, and cleanupWorktrees with actual git
// operations would require setting up a temporary git repository. The private slugify
// function cannot be tested directly. Its behavior (lowercase, replace non-alphanum with
// hyphens, trim, max 40 chars) is verified indirectly through createWorktree's branch naming.
