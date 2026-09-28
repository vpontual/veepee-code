import { describe, it, expect, afterEach } from 'vitest';
import { ollamaNumCtx, OLLAMA_DEFAULT_NUM_CTX } from '../src/ollama-context.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

let calls = 0;
function serve(modelInfo: Record<string, unknown> | null, status = 200) {
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify(modelInfo ? { model_info: modelInfo } : { error: 'not found' }), { status });
  }) as typeof fetch;
}

// Each test uses its own proxy URL: results are cached per (proxy, model).
describe('ollamaNumCtx', () => {
  it('caps the model maximum at the default window', async () => {
    serve({ 'qwen2.context_length': 32768 });
    expect(await ollamaNumCtx({ proxyUrl: 'http://a:11434', numCtx: null }, 'm')).toBe(OLLAMA_DEFAULT_NUM_CTX);
  });

  it('uses the model maximum when it is smaller', async () => {
    serve({ 'llama.context_length': 8192 });
    expect(await ollamaNumCtx({ proxyUrl: 'http://b:11434', numCtx: null }, 'm')).toBe(8192);
  });

  it('honours a configured numCtx', async () => {
    serve({ 'qwen3.context_length': 40960 });
    expect(await ollamaNumCtx({ proxyUrl: 'http://c:11434', numCtx: 32768 }, 'm')).toBe(32768);
  });

  it('returns undefined when the server cannot describe the model, so nothing is sent', async () => {
    serve(null, 404);
    expect(await ollamaNumCtx({ proxyUrl: 'http://d:11434', numCtx: null }, 'vllm-model')).toBeUndefined();
    expect(await ollamaNumCtx({ proxyUrl: '', numCtx: null }, 'm')).toBeUndefined();
  });

  it('asks once per model', async () => {
    serve({ 'qwen2.context_length': 32768 });
    await ollamaNumCtx({ proxyUrl: 'http://e:11434', numCtx: null }, 'm');
    await ollamaNumCtx({ proxyUrl: 'http://e:11434', numCtx: null }, 'm');
    expect(calls).toBe(1);
  });
});

import { vllmMaxModelLen } from '../src/ollama-context.js';

describe('vLLM windows (max_model_len)', () => {
  it('uses the full max_model_len of a vLLM model behind a gateway, uncapped', async () => {
    globalThis.fetch = (async (url: string) => String(url).endsWith('/api/show')
      ? new Response('{"error":"not found"}', { status: 404 })
      : new Response(JSON.stringify({ data: [{ id: 'gemma4:26b-a4b', max_model_len: 32768 }] }), { status: 200 })) as typeof fetch;
    expect(await ollamaNumCtx({ proxyUrl: 'http://gw:11434', numCtx: null }, 'gemma4:26b-a4b')).toBe(32768);
  });

  it('reads max_model_len from a direct server, with or without /v1 in the URL', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'm', max_model_len: 131072 }] }), { status: 200 })) as typeof fetch;
    expect(await vllmMaxModelLen('http://gpu:8000/v1', 'm')).toBe(131072);
    expect(await vllmMaxModelLen('http://gpu:8000', 'other')).toBeUndefined();
  });
});
