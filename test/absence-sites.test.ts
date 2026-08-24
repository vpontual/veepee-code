import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { TRUNCATED_ARGS_KEY } from '../src/openai-adapter.js';
import { z } from 'zod';

/**
 * Fault injection for the ABSENCE SITES — every point where a value can be
 * missing and something must still be handed to the model.
 *
 * This class of bug is the one a pass rate can never surface, because it makes
 * the agent MORE likely to pass while being wrong: a timeout reported as clean,
 * a failing command reported as successful, a truncated call executed with
 * defaults. Five were found and fixed in a single day, which says nothing about
 * how many remain — so the standing form is a suite that forces each failure and
 * asserts the model-visible string says "unavailable", not nothing.
 *
 * See docs/absence-sites.md for the enumeration this suite tracks.
 */
describe('a truncated tool call is not a call with default arguments', () => {
  it('refuses to execute it, and says why', async () => {
    const registry = new ToolRegistry();
    let ran = false;
    registry.register({
      name: 'list_files',
      description: 'all arguments optional',
      schema: z.object({ path: z.string().optional() }),
      execute: async () => { ran = true; return { success: true, output: 'listed' }; },
    } as never);

    // A stream cut off mid-arguments used to parse as `{}` — which for a tool
    // whose arguments are all optional is a VALID call, so the truncated
    // request executed as a defaulted one and reported success.
    const result = await registry.execute('list_files', { [TRUNCATED_ARGS_KEY]: '{"path":"/ho' });
    expect(ran).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain('truncated');
    expect(result.error).toContain('NOT executed');
    // The model needs to know it can simply retry.
    expect(result.error).toContain('Send it again');
  });

  it('leaves an ordinary call alone', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'list_files',
      description: 'all arguments optional',
      schema: z.object({ path: z.string().optional() }),
      execute: async () => ({ success: true, output: 'listed' }),
    } as never);
    const result = await registry.execute('list_files', {});
    expect(result.success).toBe(true);
  });
});

describe('compaction without a summary tells the model so', () => {
  it('inserts an explicit notice when the summarizer produces nothing', async () => {
    const { ContextManager } = await import('../src/context.js');
    const c = new ContextManager();
    c.setSystemPrompt('qwen3');
    // Enough traffic to overflow the window budget, or nothing is dropped and
    // there is no absence to report.
    for (let i = 0; i < 150; i++) {
      c.addUser(`turn ${i} ${'x'.repeat(8_000)}`);
      c.addAssistant(`reply ${i} ${'y'.repeat(8_000)}`);
    }
    // No summarizer reachable: the host is unroutable, so the model call fails
    // and compaction falls back to drop-only — which is where the silence was.
    await c.compactAsync('http://127.0.0.1:9', 'nonexistent-model');
    const text = c.getAllMessages().map((m) => m.content ?? '').join('\n');
    // Dropped-without-a-summary is not the same as compacted, and the model
    // used to be told nothing at all — so it kept citing detail that was gone.
    expect(text).toContain('NO summary could be produced');
    expect(text).toContain('Re-read what you need');
  }, 60_000);
});
