/**
 * The context window (num_ctx) to request from an Ollama model.
 *
 * Without one, Ollama uses its default window — 4096 tokens on current
 * releases — while vcode's system prompt plus tool definitions is ~4.8k.
 * Ollama truncates silently: on a fresh install qwen2.5-coder:7b saw
 * prompt_eval_count=4096, lost the tool result, and asked for the same file
 * until the loop detector stopped it. With num_ctx=16384 the same request
 * answered correctly.
 *
 * Asks /api/show once per model for its real maximum. Returns undefined when
 * the server cannot say (e.g. a vLLM model behind a gateway), which keeps the
 * old behaviour of sending no num_ctx. OpenAI-compatible servers own their
 * window, so callers skip this for them.
 */
import type { Config } from './config.js';

/** Default when `numCtx` is not configured: room for vcode's prompt plus a
 *  real conversation, without asking a small GPU for a 128k KV cache. */
export const OLLAMA_DEFAULT_NUM_CTX = 16_384;

const cache = new Map<string, Promise<number | undefined>>();

export function ollamaNumCtx(config: Pick<Config, 'proxyUrl' | 'numCtx'>, model: string): Promise<number | undefined> {
  if (!model || !config.proxyUrl) return Promise.resolve(undefined);
  const key = `${config.proxyUrl}\u0000${model}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const max = await lookup(config.proxyUrl, model);
      if (max) return Math.min(max, config.numCtx ?? OLLAMA_DEFAULT_NUM_CTX);
      // Not an Ollama model: a vLLM model behind a gateway publishes its window
      // as max_model_len. It costs no memory to use all of it, so no cap — but
      // it must be KNOWN, or vcode assumes 131k and asks gemma4 (32k) for 16k
      // tokens of output on a 16k prompt, which vLLM refuses outright.
      return vllmMaxModelLen(config.proxyUrl, model);
    })();
    cache.set(key, hit);
  }
  return hit;
}

/** `max_model_len` for `model` from an OpenAI-compatible `/v1/models` (vLLM, or a gateway in front of it). */
export async function vllmMaxModelLen(baseUrl: string, model: string, apiKey?: string | null): Promise<number | undefined> {
  try {
    const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const res = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return undefined;
    const data = ((await res.json()) as { data?: Array<{ id?: string; max_model_len?: unknown }> }).data ?? [];
    const len = data.find(m => m.id === model)?.max_model_len;
    return typeof len === 'number' && len > 0 ? len : undefined;
  } catch {
    return undefined;
  }
}

async function lookup(proxyUrl: string, model: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${proxyUrl.replace(/\/+$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return undefined;
    const info = ((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {};
    const max = Object.entries(info).find(([k, v]) => k.endsWith('.context_length') && typeof v === 'number')?.[1];
    return typeof max === 'number' && max > 0 ? max : undefined;
  } catch {
    return undefined;
  }
}
