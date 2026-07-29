import { describe, it, expect } from 'vitest';
import { PermissionManager, isRecursiveRm, isForcePush, isGitClean } from '../src/permissions.js';

/**
 * DANGEROUS_PATTERNS is the only check that survives an "always"/"session"
 * grant — check() consults it before alwaysAllowed — so these matchers have to
 * resist equivalent spellings, not just the one canonical form.
 */
describe('isRecursiveRm', () => {
  it('catches every spelling of a recursive delete', () => {
    for (const cmd of [
      'rm -rf /tmp/x',
      'rm -fr /tmp/x',        // regressed the old /\brm\s+-rf?\b/
      'rm -r -f /tmp/x',
      'rm -f -r /tmp/x',
      'rm --recursive --force /tmp/x',
      'rm -Rf /tmp/x',
      'rm -r /tmp/x',          // recursive alone still confirms, as before
      'sudo rm -rf /',
      'echo hi; rm -fr /tmp/x',
      'make clean && rm -rf dist',
    ]) {
      expect(isRecursiveRm(cmd), cmd).toBe(true);
    }
  });

  it('does not fire on harmless commands', () => {
    for (const cmd of [
      'rm file.txt',
      'npm run rm-cache',
      'git status',
      'echo "confirm"',
      'ls -la',
    ]) {
      expect(isRecursiveRm(cmd), cmd).toBe(false);
    }
  });
});

describe('isForcePush', () => {
  it('catches the short flag the old matcher missed', () => {
    for (const cmd of [
      'git push -f origin main',
      'git push --force origin main',
      'git push --force-with-lease',
      'git push --force-with-lease=main',
      'git push origin main -f',
    ]) {
      expect(isForcePush(cmd), cmd).toBe(true);
    }
  });

  it('leaves ordinary pushes alone', () => {
    expect(isForcePush('git push origin main')).toBe(false);
    expect(isForcePush('git pull --rebase')).toBe(false);
  });
});

describe('isGitClean', () => {
  it('catches untracked-file deletion', () => {
    for (const cmd of ['git clean -fdx', 'git clean -f', 'git clean --force -d', 'git clean -xdf']) {
      expect(isGitClean(cmd), cmd).toBe(true);
    }
  });

  it('ignores the no-op dry form and unrelated cleans', () => {
    expect(isGitClean('git clean -n')).toBe(false);
    expect(isGitClean('make clean')).toBe(false);
  });
});

describe('PermissionManager.isReadOnlyGit', () => {
  it('auto-allows routine inspection', () => {
    for (const args of ['status', 'diff --staged', 'log --oneline -10', 'show HEAD', 'rev-parse HEAD', 'blame src/x.ts']) {
      expect(PermissionManager.isReadOnlyGit({ args }), args).toBe(true);
    }
  });

  it('refuses anything that mutates or publishes', () => {
    for (const args of [
      'push -f origin main',
      'clean -fdx',
      'reset --hard HEAD~3',
      'checkout .',
      'commit -m wip',
      'branch -D feature',
      'stash drop',
      'add .',
    ]) {
      expect(PermissionManager.isReadOnlyGit({ args }), args).toBe(false);
    }
  });

  it('refuses global options that can execute code before the subcommand', () => {
    // `git -c core.pager=<cmd> log` runs <cmd>: a read-only subcommand is not
    // enough to make the invocation safe.
    for (const args of [
      "-c core.pager=sh log",
      '-c alias.x=!whoami log',
      '--config-env=core.pager=EVIL log',
      'diff --output=/tmp/pwned',
      'log --ext-diff',
    ]) {
      expect(PermissionManager.isReadOnlyGit({ args }), args).toBe(false);
    }
  });

  it('refuses empty args', () => {
    expect(PermissionManager.isReadOnlyGit({})).toBe(false);
    expect(PermissionManager.isReadOnlyGit({ args: '   ' })).toBe(false);
  });
});

describe('git is no longer blanket-safe', () => {
  it('is absent from the auto-allow tool list', () => {
    const perms = new PermissionManager();
    expect(perms.listPermissions().safeTools).not.toContain('git');
  });
});
