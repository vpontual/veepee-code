import { describe, it, expect } from 'vitest';
import { isTestFile, detectTestCommand, taskFromCommit, prepareRepoWorkspace, runSuite, cleanupWorkspace } from '../src/repo-eval.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * The small harness suite measures purpose-built problems. This measures the
 * actual goal: a real repo, a real change someone made, and that repo's own
 * test suite as the grader.
 */
describe('test-file classification', () => {
  it('recognises the layouts these repos actually use', () => {
    for (const p of ['test/agent.test.ts', 'src/lib.test.js', 'tests/test_api.py',
                     '__tests__/x.tsx', 'spec/foo.spec.ts', 'api/test_thing.py']) {
      expect(isTestFile(p), p).toBe(true);
    }
  });

  it('does not mistake source for tests', () => {
    for (const p of ['src/agent.ts', 'src/testing-utils.ts', 'lib/protest.js', 'src/latest.ts']) {
      expect(isTestFile(p), p).toBe(false);
    }
  });
});

describe('task construction from a real commit', () => {
  const repo = process.cwd();

  it('finds this repo\'s own test command', async () => {
    expect(await detectTestCommand(repo)).toBe('npm test --silent');
  });

  it('builds a task whose prompt is the commit message, never the diff', async () => {
    // A commit of this repo that changed both source and tests.
    const task = await taskFromCommit(repo, 'c3d71ea7a');
    expect(typeof task).not.toBe('string');
    if (typeof task === 'string') return;
    expect(task.srcFiles).toContain('src/permissions.ts');
    expect(task.testFiles).toContain('test/permissions-dangerous.test.ts');
    expect(task.prompt).toContain('guard the git commands');
    // The instruction a person had — never the diff.
    expect(task.prompt).not.toContain('+++');
    expect(task.prompt).not.toContain('@@');
    // NOTE: a commit message MAY name the identifier it introduced — this
    // repo's own messages routinely do, and that makes its commits easier
    // tasks than they look. Tasks drawn from the app repos (socialfeed,
    // newsfeed, dogear, veetv) read like intent — "Stop the feed and the
    // cluster page disagreeing about the story" — and are the fairer sample.
    // Scoring should not mix the two populations without saying which.
    // Trailers say who wrote it, not what to do.
    expect(task.prompt).not.toContain('Co-Authored-By');
  });

  it('refuses commits that cannot grade themselves', async () => {
    // A docs/test-only or oversized commit is not a task; saying so beats
    // silently scoring a vacuous one.
    const notATask = await taskFromCommit(repo, 'HEAD~0');
    if (typeof notATask === 'string') expect(notATask.length).toBeGreaterThan(0);
  });
});

describe('workspace preparation', () => {
  it('checks out the parent and restores only the tests', async () => {
    const task = await taskFromCommit(process.cwd(), 'c3d71ea7a');
    if (typeof task === 'string') throw new Error(task);
    const work = await prepareRepoWorkspace(task);
    try {
      // The grading test exists…
      expect(existsSync(join(work, 'test/permissions-dangerous.test.ts'))).toBe(true);
      const testSrc = readFileSync(join(work, 'test/permissions-dangerous.test.ts'), 'utf-8');
      expect(testSrc).toContain('isGitConfigMutation');
      // …and the implementation does not.
      const impl = readFileSync(join(work, 'src/permissions.ts'), 'utf-8');
      expect(impl).not.toContain('isGitConfigMutation');
      // node_modules is linked, not installed — an install per task would
      // measure the network instead of the harness.
      expect(existsSync(join(work, 'node_modules'))).toBe(true);
    } finally {
      await cleanupWorkspace(work);
    }
  }, 60_000);

  it('starts from a FAILING suite, which is what makes the task real', async () => {
    const task = await taskFromCommit(process.cwd(), 'c3d71ea7a');
    if (typeof task === 'string') throw new Error(task);
    const work = await prepareRepoWorkspace(task);
    try {
      // A task whose tests already pass measures nothing at all.
      const before = runSuite(work, 'npx vitest run test/permissions-dangerous.test.ts', 120_000);
      expect(before.passed).toBe(false);
    } finally {
      await cleanupWorkspace(work);
    }
  }, 180_000);
});
