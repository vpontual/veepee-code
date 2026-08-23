import { describe, it, expect } from 'vitest';
import { PermissionManager, isRecursiveRm, isForcePush, isGitClean, isGitConfigMutation } from '../src/permissions.js';

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

/**
 * The config-mutation class. Nothing here deletes a file, which is exactly why
 * it needed its own guard: these commands change what every LATER command
 * MEANS, so a broken one invalidates every measurement taken after it —
 * including the agent's own verification of its own work.
 *
 * The incident (2026-08-23): asked only to REPORT sync state, an agent wrote
 * `upstream=$(git branch --u 2>/dev/null | ...)` meaning "show me the upstream".
 * Git accepts any unambiguous long-option abbreviation, so `--u` IS
 * `--unset-upstream` — silent, exit 0 — and it wiped tracking in all 37 repos
 * under ~/Dev. It then reported them all "synced, zero ahead, zero behind":
 * with tracking gone its `HEAD.."$upstream"` collapsed to `HEAD..HEAD` = 0, and
 * `git status -sb` prints a bare `## main` instead of `## main...origin/main
 * [ahead 1]`, which its verification step scored as clean.
 */
describe('isGitConfigMutation', () => {
  it('catches the abbreviation that caused the incident', () => {
    expect(isGitConfigMutation("upstream=$(git branch --u 2>/dev/null | sed 's/x//')")).toBe(true);
  });

  it('catches every abbreviation of an upstream change, since git does too', () => {
    for (const cmd of [
      'git branch --u',
      'git branch --un',
      'git branch --unset',
      'git branch --unset-upstream',
      'git branch --unset-upstream main',
      'git -C /home/vp/Dev/newsfeed branch --u',
      'cd /tmp && git branch --set-upstream-to=origin/main',
      'for d in */; do cd "$d"; git branch --u; done',
    ]) {
      expect(isGitConfigMutation(cmd), cmd).toBe(true);
    }
  });

  it('catches config writes, remote surgery and forced branch moves', () => {
    for (const cmd of [
      'git config user.email x@y.z',
      'git config --unset branch.main.remote',
      'git config --unset-all branch.main.merge',
      'git config --remove-section branch.main',
      'git config set core.editor vim',
      'git remote set-url origin git@github.com:someone/else.git',
      'git remote remove origin',
      'git remote add upstream https://example.invalid/x.git',
      'git checkout -B main origin/other',
      'git switch -C main',
    ]) {
      expect(isGitConfigMutation(cmd), cmd).toBe(true);
    }
  });

  it('leaves reads and routine work alone', () => {
    for (const cmd of [
      'git config --get branch.main.remote',
      'git config --get-regexp "^branch\\."',
      'git config --list',
      'git config -l',
      'git config get user.email',
      'git branch --show-current',
      'git branch -a',
      'git branch --contains HEAD',
      'git remote -v',
      'git remote get-url origin',
      'git status -sb',
      'git checkout -b feature',        // -b creates; only -B MOVES an existing ref
      'git switch -c feature',
      'git push -u origin main',        // sets tracking on publish: routine, not surgery
      'git log src/config.ts',          // a PATH named config is not the subcommand
      'git diff --stat src/remote/branch.ts',
      'git log --grep "unset-upstream"',
    ]) {
      expect(isGitConfigMutation(cmd), cmd).toBe(false);
    }
  });

  it('is wired into both the bash and git tool paths', async () => {
    const pm = new PermissionManager();
    pm.setPromptHandler(async () => 'deny');
    // It reaches the prompt at all — which is the whole point: without the
    // guard this is a plain bash command and never asks.
    expect(await pm.check('bash', { command: 'git branch --u' })).toBe('deny');
    expect(await pm.check('git', { args: 'branch --u' })).toBe('deny');
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
