import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { TRUNCATED_ARGS_KEY } from '../src/openai-adapter.js';
import { z } from 'zod';
import { readFileSync } from 'fs';

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

describe('an empty fetch is a fact about the fetch', () => {
  it('says the body was unreadable instead of returning nothing', async () => {
    const { registerWebTools } = await import('../src/tools/web.js');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', {
      status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' },
    })) as typeof fetch;
    try {
      const tool = registerWebTools({ } as never).find((t) => t.name === 'web_fetch');
      const r = await tool!.execute({ url: 'https://example.invalid/' });
      // '' made a 200-with-no-body, a JS-only shell and a real empty page
      // indistinguishable — and all three read as "the page said nothing".
      expect(String(r.output)).toContain('no readable body');
      expect(String(r.output)).toContain('JavaScript-rendered');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('write_file creates the directory it is asked to write into', () => {
  it('writes a new file into a directory that does not exist yet', async () => {
    const { registerCodingTools } = await import('../src/tools/coding.js');
    const { mkdtemp, rm, readFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'vcode-write-'));
    try {
      const write = registerCodingTools().find((t) => t.name === 'write_file')!;
      const target = join(dir, 'server', 'lib', 'motion.mjs');
      // Measured on a real replay task: a bare ENOENT here made the model retry
      // the identical call three times, the loop guard stopped the run, and 432
      // seconds were logged as the model being stuck.
      const r = await write.execute({ path: target, content: 'export const x = 1;\n' });
      expect(r.success).toBe(true);
      expect(await readFile(target, 'utf-8')).toContain('export const x = 1;');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a single tool result cannot eat the context window', () => {
  it('bounds bash output to a context budget, not a memory limit', async () => {
    const { boundedStream } = await import('../src/tools/coding.js');
    const s = boundedStream();
    s.push('x'.repeat(2_000_000));
    // 192KB per end was 384KB — ~110k tokens, 84% of a 131k window, in ONE
    // result. Measured: a real task died at 8 seconds with
    // "your prompt contains at least 128001 input tokens" after two calls.
    // No compaction saves a turn whose single result does not fit.
    expect(s.text().length).toBeLessThan(60_000);
    expect(s.text()).toContain('dropped from the middle');
  });
});

describe('a guard may not take a terminal action on an inferred state', () => {
  it('warns on a repeated identical failure before it ever stops the run', () => {
    const src = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf-8');
    // Whether three identical failing calls are a loop or a debugging cycle is
    // an INFERENCE from an ambiguous signal — and this guard was wrong once,
    // killing an agent 34 tool calls into a real multi-file change. Terminal
    // actions need a proven state (an exit code, a byte count, a wall clock);
    // inferences get to speak and be overruled.
    expect(src).toContain('repeatedFailureWarned');
    expect(src).toContain('Warned: repeated identical failure');
    const warnAt = src.indexOf('Warned: repeated identical failure');
    const stopAt = src.indexOf('kept failing with identical arguments after a warning');
    expect(warnAt).toBeGreaterThan(0);
    expect(stopAt).toBeGreaterThan(warnAt);
  });

  it('gives the agent a channel to be told things mid-run', async () => {
    const { Agent } = await import('../src/agent.js');
    expect(typeof Agent.prototype.notify).toBe('function');
  });
});
