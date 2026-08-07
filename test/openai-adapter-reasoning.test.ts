import { describe, it, expect, afterEach } from 'vitest';
import { OpenAIChatClient } from '../src/openai-adapter.js';

/**
 * Regression: the reasoning field name is server-specific, and reading the
 * wrong one fails SILENTLY — no error, no warning, just an empty answer.
 *
 * vLLM 0.23.1 on the DGX Spark (`--reasoning-parser deepseek_r1`) emits
 * `delta.reasoning`. The adapter originally read only `delta.reasoning_content`,
 * which that server never sends. Measured against the live engine 2026-08-07:
 * with `enable_thinking: true` — vcode's default, since `think` defaults to
 * `params.think !== false` — a plain prompt returned content = 0 chars and
 * reasoning = 849 chars. A real `vcode -p "find and fix a bug"` run against it
 * read nine files over four turns and printed ONE BYTE.
 *
 * Tool calls were never affected (they arrive in `delta.tool_calls`), which is
 * why the agent appeared to be doing nothing while it was in fact working —
 * the single most misleading part of the failure.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sseResponse(frames: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function stubFetch(frames: unknown[]) {
  globalThis.fetch = (async () => sseResponse(frames)) as typeof fetch;
}

async function collectContent(client: OpenAIChatClient): Promise<string> {
  const stream = await client.chat({ model: 'm', messages: [] });
  let out = '';
  for await (const chunk of stream) out += chunk.message?.content ?? '';
  return out;
}

describe('OpenAIChatClient reasoning extraction', () => {
  const client = new OpenAIChatClient('http://example.invalid:8000');

  it('folds vLLM 0.23.1 `delta.reasoning` into content', async () => {
    stubFetch([
      { choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { reasoning: 'the sky ' } }] },
      { choices: [{ delta: { reasoning: 'is blue' } }] },
    ]);
    expect(await collectContent(client)).toBe('the sky is blue');
  });

  it('still folds `delta.reasoning_content` for servers that use that name', async () => {
    stubFetch([
      { choices: [{ delta: { reasoning_content: 'alpha' } }] },
      { choices: [{ delta: { reasoning_content: 'beta' } }] },
    ]);
    expect(await collectContent(client)).toBe('alphabeta');
  });

  it('does not double-emit when a server sends both spellings', async () => {
    stubFetch([
      { choices: [{ delta: { reasoning: 'x', reasoning_content: 'x' } }] },
    ]);
    expect(await collectContent(client)).toBe('x');
  });

  it('keeps normal content working alongside reasoning', async () => {
    stubFetch([
      { choices: [{ delta: { reasoning: 'think ' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
    ]);
    expect(await collectContent(client)).toBe('think answer');
  });

  it('emits tool calls regardless of which reasoning field is used', async () => {
    stubFetch([
      { choices: [{ delta: { reasoning: 'deciding' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
    ]);
    const stream = await client.chat({ model: 'm', messages: [] });
    const calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
    for await (const chunk of stream) {
      if (chunk.message?.tool_calls) calls.push(...chunk.message.tool_calls);
    }
    expect(calls).toEqual([{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }]);
  });
});
