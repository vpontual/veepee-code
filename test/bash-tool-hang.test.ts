import { describe, it, expect } from 'vitest';
import { registerCodingTools } from '../src/tools/coding.js';

/**
 * Regression tests for the hang verified before the fix: the tool resolved on
 * 'close', which waits for stdio EOF. A backgrounded grandchild inherits the
 * stdout pipe and holds it open, so `bash -c 'sleep 8 & echo hi'` took the
 * full 8s — and the spawn `timeout` never fired, because the direct `bash`
 * child had already exited.
 */
function bashTool() {
  const tool = registerCodingTools().find(t => t.name === 'bash');
  if (!tool) throw new Error('bash tool not registered');
  return tool;
}

describe('bash tool — background processes must not stall the result', () => {
  it('returns promptly when the command backgrounds a long-lived process', async () => {
    const started = Date.now();
    const result = await bashTool().execute({
      command: 'sleep 30 & echo started-and-backgrounded',
      timeout: 60_000,
    });
    const elapsed = Date.now() - started;

    // Pre-fix this waited on the grandchild: ~30s. It must now return on the
    // command's own exit plus the flush grace, nowhere near the 30s sleep.
    expect(elapsed).toBeLessThan(5_000);
    expect(result.success).toBe(true);
    expect(result.output).toContain('started-and-backgrounded');
    expect(result.output).toContain('background process');
  }, 40_000);

  /**
   * The grace path used to call `ok(...)` unconditionally — `child.on('exit', ...)`
   * discarded the exit code — so ANY command that left a background process
   * reported success however it exited. That is a failing test run, a failing
   * build, or a failing deploy read by the model as a pass, with the self-repair
   * guard treating the turn as verified.
   */
  it('reports failure when a command exits non-zero AND leaves a background process', async () => {
    const result = await bashTool().execute({
      command: 'sleep 30 & echo working; exit 3',
      timeout: 60_000,
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Exit code 3');
    expect(String(result.error)).toContain('working');
    // The user still needs to know something was left running.
    expect(String(result.error)).toContain('background process');
  }, 40_000);

  it('reports failure when a command is killed by a signal', async () => {
    const result = await bashTool().execute({ command: 'kill -TERM $$', timeout: 20_000 });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/SIGTERM|Exit code/);
  }, 30_000);

  it('still returns complete output for ordinary commands', async () => {
    const result = await bashTool().execute({ command: 'echo one; echo two; echo three' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('one');
    expect(result.output).toContain('two');
    expect(result.output).toContain('three');
    // No spurious background note when nothing was backgrounded.
    expect(result.output).not.toContain('background process');
  }, 20_000);

  it('reports a non-zero exit as a failure, with output', async () => {
    const result = await bashTool().execute({ command: 'echo before-failure; exit 3' });
    expect(result.success).toBe(false);
    expect(result.error || result.output).toContain('before-failure');
  }, 20_000);

  it('enforces its timeout and kills the whole process group', async () => {
    const started = Date.now();
    const result = await bashTool().execute({
      // The grandchild would outlive a kill aimed only at the direct child.
      command: 'sleep 30 & sleep 30',
      timeout: 1_500,
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(6_000);
    expect(result.success).toBe(false);
    expect(result.error || '').toMatch(/timed out/i);
  }, 30_000);

  it('captures stderr alongside stdout', async () => {
    const result = await bashTool().execute({ command: 'echo to-out; echo to-err 1>&2' });
    expect(result.output).toContain('to-out');
    expect(result.output).toContain('to-err');
  }, 20_000);
});

describe('interrupt reaches running commands', () => {
  it('kills a running bash command when the agent aborts', async () => {
    const { killRunningBashCommands } = await import('../src/tools/coding.js');
    const started = Date.now();
    const pending = bashTool().execute({ command: 'sleep 25; echo done', timeout: 60_000 });
    // Give the child time to actually spawn before interrupting.
    await new Promise(r => setTimeout(r, 400));
    // Ctrl+C used to abort the model stream only: the command kept running and
    // the terminal stayed hostage for the full timeout.
    expect(killRunningBashCommands()).toBeGreaterThan(0);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.success).toBe(false);
    expect(killRunningBashCommands()).toBe(0); // unregistered once settled
  }, 30_000);
});

describe('output truncation keeps the end, where the error is', () => {
  it('keeps head and tail and says what it dropped', async () => {
    const { boundedStream } = await import('../src/tools/coding.js');
    const s = boundedStream(100, 100);
    s.push('H'.repeat(100));
    s.push('M'.repeat(5_000));
    s.push('T'.repeat(100));
    const text = s.text();
    // Pre-fix this kept the first 512 KB and discarded the rest — for a build
    // log or a stack trace that throws away the diagnosis.
    expect(text.startsWith('H'.repeat(100))).toBe(true);
    expect(text.endsWith('T'.repeat(100))).toBe(true);
    expect(text).toContain('dropped from the middle');
  });

  it('does not annotate output that fit', async () => {
    const { boundedStream } = await import('../src/tools/coding.js');
    const s = boundedStream(100, 100);
    s.push('short');
    expect(s.text()).toBe('short');
  });

  it('preserves the tail of a real command', async () => {
    const result = await bashTool().execute({
      command: 'for i in $(seq 1 20000); do echo "line $i"; done; echo FINAL_MARKER',
      timeout: 60_000,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('FINAL_MARKER');
  }, 30_000);
});
