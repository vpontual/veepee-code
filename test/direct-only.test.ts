/**
 * An install with no gateway: `llmBackend: "openai"` and an empty `proxyUrl`.
 * Every path that used to assume `proxyUrl` must reach the direct server
 * instead of falling back to http://localhost:11434.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, type Config } from '../src/config.js';
import { isDirectOnly, primaryEndpoint, createChatClient } from '../src/llm-client.js';
import { OpenAIChatClient } from '../src/openai-adapter.js';
import { ModelManager } from '../src/models.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sse(frames: unknown[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const DIRECT = { llmBackend: 'openai' as const, openaiBaseUrl: 'http://gpu:8000', openaiApiKey: null, proxyUrl: '' };

describe('isDirectOnly', () => {
  it('is true only for an openai backend with a base URL and no gateway', () => {
    expect(isDirectOnly(DIRECT)).toBe(true);
    expect(isDirectOnly({ ...DIRECT, proxyUrl: 'http://gw:11434' })).toBe(false); // hybrid
    expect(isDirectOnly({ ...DIRECT, llmBackend: 'ollama' })).toBe(false);
    expect(isDirectOnly({ ...DIRECT, openaiBaseUrl: null })).toBe(false);
  });

  it('names the direct server as the endpoint, and the gateway otherwise', () => {
    expect(primaryEndpoint(DIRECT)).toBe('http://gpu:8000');
    expect(primaryEndpoint({ ...DIRECT, proxyUrl: 'http://gw:11434' })).toBe('http://gw:11434');
  });

  it('hands secondary callers the OpenAI client when there is no gateway', () => {
    expect(createChatClient(DIRECT)).toBeInstanceOf(OpenAIChatClient);
    expect(createChatClient({ ...DIRECT, proxyUrl: 'http://gw:11434' })).not.toBeInstanceOf(OpenAIChatClient);
  });
});

describe('loadConfig proxyUrl', () => {
  const write = (obj: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), 'vcode-cfg-')), 'settings.json');
    writeFileSync(path, JSON.stringify(obj));
    return path;
  };

  it('keeps an empty proxyUrl instead of defaulting to localhost', () => {
    expect(loadConfig(write({ proxyUrl: '' })).proxyUrl).toBe('');
  });

  it('treats null as no gateway too', () => {
    expect(loadConfig(write({ proxyUrl: null })).proxyUrl).toBe('');
  });

  it('still defaults an absent proxyUrl', () => {
    expect(loadConfig(write({})).proxyUrl).toBe('http://localhost:11434');
  });
});

describe('OpenAIChatClient without stream: true', () => {
  it('returns one collected response, like Ollama with stream: false', async () => {
    globalThis.fetch = (async () => sse([
      { choices: [{ delta: { reasoning: 'think ' } }] },
      { choices: [{ delta: { content: 'hello ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ])) as typeof fetch;

    const resp = await new OpenAIChatClient('http://gpu:8000').chat({ model: 'm', messages: [] });
    expect(resp.done).toBe(true);
    expect(resp.message.content).toBe('hello world');
    expect(resp.message.thinking).toBe('think ');
    expect(resp.message.tool_calls).toEqual([{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }]);
    expect(resp.eval_count).toBe(4);
    expect(resp.prompt_eval_count).toBe(10);
  });
});

describe('ModelManager.discover with no gateway', () => {
  const config = {
    ...DIRECT,
    dashboardUrl: '',
    model: null,
    lockModel: null,
    autoSwitch: true,
    maxModelSize: 40,
    minModelSize: 12,
  } as unknown as Config;

  it('lists models from /v1/models on the direct server', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: 'Qwen/Qwen3.6-35B-A3B-FP8', max_model_len: 131072 }] }), { status: 200 });
    }) as typeof fetch;

    const mm = new ModelManager(config);
    await mm.discover();
    expect(urls).toEqual(['http://gpu:8000/v1/models']);
    const [m] = mm.getAllModels();
    expect(m.name).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
    expect(m.parameterCount).toBe(35);
    expect(m.contextLength).toBe(131072);
    expect(mm.selectDefault()).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
  });

  it('fails loudly when the server is down, so startup reports a connection error', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    await expect(new ModelManager(config).discover()).rejects.toThrow('HTTP 502');
  });
});
