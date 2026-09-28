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
    hit = lookup(config.proxyUrl, model).then(max => (max ? Math.min(max, config.numCtx ?? OLLAMA_DEFAULT_NUM_CTX) : undefined));
    cache.set(key, hit);
  }
  return hit;
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
