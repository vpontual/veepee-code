/**
 * Which server vcode talks to, and the client every caller uses to reach it.
 *
 * Three shapes of install:
 *  - gateway only (`llmBackend: "ollama"`): everything goes to `proxyUrl`.
 *  - hybrid (`llmBackend: "openai"` + a `proxyUrl`): the primary model goes
 *    straight to `openaiBaseUrl`; every other model (subagents, compaction on a
 *    different summarizer, /models) is found behind the gateway.
 *  - direct only (`llmBackend: "openai"`, `proxyUrl` empty): there is no
 *    gateway. EVERY caller must go to `openaiBaseUrl`, or it silently falls
 *    back to the `http://localhost:11434` default and fails there.
 *
 * Secondary callers used to build `new Ollama({ host: config.proxyUrl })`
 * themselves, which is exactly what made the gateway mandatory. They go
 * through {@link createChatClient} instead.
 */
import { Ollama } from 'ollama';
import type { Config } from './config.js';
import { OpenAIChatClient } from './openai-adapter.js';

type EndpointConfig = Pick<Config, 'llmBackend' | 'openaiBaseUrl' | 'openaiApiKey' | 'proxyUrl'>;

/** True when there is no gateway and all traffic goes to the OpenAI-compatible server. */
export function isDirectOnly(config: EndpointConfig): boolean {
  return config.llmBackend === 'openai' && !!config.openaiBaseUrl && !config.proxyUrl;
}

/** The URL to name in errors and diagnostics — the server vcode actually depends on. */
export function primaryEndpoint(config: EndpointConfig): string {
  return isDirectOnly(config) ? config.openaiBaseUrl! : config.proxyUrl;
}

/**
 * A chat client with the Ollama `.chat()` surface. Streams only when the call
 * passes `stream: true`, like the Ollama client itself.
 */
export function createChatClient(config: EndpointConfig): Ollama {
  if (isDirectOnly(config)) {
    return new OpenAIChatClient(config.openaiBaseUrl!, config.openaiApiKey ?? undefined) as unknown as Ollama;
  }
  return new Ollama({ host: config.proxyUrl, headers: { 'x-ollama-source': 'vcode' } });
}
