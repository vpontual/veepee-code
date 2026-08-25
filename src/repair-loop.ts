/**
 * Pure repair-loop helpers for print mode (-p).
 * No I/O, no side effects — everything is a function call.
 */

// Placeholder test scripts that always fail and should not be attempted.
const PLACEHOLDER_PATTERNS = [
  'echo "Error: no test specified"',
  'echo "No test specified"',
  'echo "error: no test specified"',
];

/**
 * Read `scripts.test` from a package.json TEXT payload.
 * Returns null when absent, unparseable, or a known placeholder.
 */
export function detectTestCommand(packageJsonText: string): string | null {
  try {
    const parsed = JSON.parse(packageJsonText);
    const scripts = parsed?.scripts;
    if (typeof scripts !== 'object' || scripts === null) return null;
    const testScript = scripts.test;
    if (typeof testScript !== 'string') return null;
    // Reject placeholder / stub scripts that guarantee failure.
    for (const pat of PLACEHOLDER_PATTERNS) {
      if (testScript.includes(pat)) return null;
    }
    return testScript;
  } catch {
    return null;
  }
}

/**
 * Decision: should we attempt another repair turn?
 *
 * A null exitCode means the test run itself did not complete (timeout,
 * spawn failure, etc.). That is an infrastructure problem, not evidence
 * the code is broken — do NOT trigger a repair.
 */
export function shouldAttemptRepair(opts: {
  codeChanged: boolean;
  testCommand: string | null;
  exitCode: number | null;
  attempt: number;
  maxAttempts: number;
}): boolean {
  if (!opts.codeChanged) return false;
  if (!opts.testCommand) return false;
  if (opts.exitCode === null) return false;
  if (opts.exitCode === 0) return false;
  if (opts.attempt >= opts.maxAttempts) return false;
  return true;
}

/**
 * Build a repair prompt that tells the model to fix the CODE, not the tests.
 * Explicitly forbids weakening or deleting assertions.
 */
export function buildRepairPrompt(testCommand: string, output: string): string {
  return (
    `The test command "${testCommand}" failed with exit code non-zero.\n\n` +
    `Failure output:\n${output}\n` +
    `Fix the CODE so the tests pass. Do NOT weaken, edit, or delete any assertions.` +
    ` If you believe a test is genuinely wrong, say so explicitly in your reply rather than quietly editing it.`
  );
}

/**
 * Clip enormous test-output to head + tail with a marker between them.
 *
 * Test failure output can be huge (many test files). Keep the HEAD (first
 * failures, stack traces) and the TAIL (summary counts, pass/fail totals),
 * but drop the middle which is repetitive.
 */
export function clipOutput(text: string, maxChars = 12_000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return head + '\n\n[... output truncated, ' + (text.length - maxChars) + ' characters dropped ...]\n\n' + tail;
  }

  /**
   * Compare two snapshots of test-file metadata and classify every path that
   * changed between them into three categories: modified, deleted, added.
   *

 * Paths are sorted within each array so the output is deterministic.
 */
export function diffTestFiles(
  before: Map<string, { size: number; mtimeMs: number }>,
  after: Map<string, { size: number; mtimeMs: number }>,
): { modified: string[]; deleted: string[]; added: string[] } {
  const modified: string[] = [];
  const deleted: string[] = [];
  const added: string[] = [];

  // Modified or deleted: iterate the "before" set
  for (const [path, pre] of before) {
    const post = after.get(path);
    if (!post) {
      deleted.push(path);
    } else if (pre.size !== post.size || pre.mtimeMs !== post.mtimeMs) {
      modified.push(path);
    }
  }

  // Added: in "after" but not in "before"
  for (const [path] of after) {
    if (!before.has(path)) {
      added.push(path);
    }
  }

  modified.sort();
  deleted.sort();
  added.sort();

  return { modified, deleted, added };
}