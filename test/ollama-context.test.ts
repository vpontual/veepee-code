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
