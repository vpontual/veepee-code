import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { Agent } from '../src/agent.js';

/**
 * With `llmBackend: "openai"` the agent talks to ONE vLLM server serving one
 * model (DGX = Qwen3.6, AGX = Gemma 4 — they don't switch). A turn naming any
 * other model — `/review` routing through `reviewModel`, say — has to go
 * through the gateway, or the direct endpoint answers model-not-found.
 *
 * Agent can't be constructed in a unit test (needs Ollama + Config +
 * ToolRegistry + PermissionManager), so we exercise clientFor() against the
 * real prototype with the fields it reads stood up by hand.
 */
interface RoutingProbe {
  openaiBackend: boolean;
  directModels: Set<string>;
  gatewayClient: unknown;
  ollama: unknown;
  config: { proxyUrl: string };
  clientFor: (model: string) => { client: unknown; isAdapter: boolean };
}

const DIRECT = { tag: 'direct-vllm-client' };

function probe(opts: { openaiBackend: boolean; directModels?: string[] }): RoutingProbe {
  const p = Object.create(Agent.prototype) as unknown as RoutingProbe;
  p.openaiBackend = opts.openaiBackend;
  p.directModels = new Set(opts.directModels || []);
  p.gatewayClient = null;
  p.ollama = DIRECT;
  p.config = { proxyUrl: 'http://gateway.example:11434' };
  return p;
}

describe('Agent.clientFor — model to endpoint routing', () => {
  it('uses the single client for everything when the gateway is the transport', () => {
    // llmBackend: "ollama" — the gateway already fronts the whole fleet, so
    // every model goes to the same place and nothing needs rerouting.
    const agent = probe({ openaiBackend: false });

    for (const model of ['Qwen/Qwen3.6-35B-A3B-FP8', 'gemma4:26b-a4b', 'anything-else']) {
      const { client, isAdapter } = agent.clientFor(model);
      expect(client).toBe(DIRECT);
      expect(isAdapter).toBe(false);
    }
    expect(agent.gatewayClient).toBeNull();
  });

  it('sends the primary model straight to the direct vLLM endpoint', () => {
    const agent = probe({ openaiBackend: true, directModels: ['Qwen/Qwen3.6-35B-A3B-FP8'] });

    const { client, isAdapter } = agent.clientFor('Qwen/Qwen3.6-35B-A3B-FP8');
    expect(client).toBe(DIRECT);
    // Only the adapter consumes `signal`.
    expect(isAdapter).toBe(true);
    expect(agent.gatewayClient).toBeNull();
  });

  it('routes a model the direct endpoint lacks through the gateway', () => {
    // This is the /review case: reviewModel gemma4 lives on the AGX, but the
    // direct endpoint is the DGX, which only serves Qwen.
    const agent = probe({ openaiBackend: true, directModels: ['Qwen/Qwen3.6-35B-A3B-FP8'] });

    const { client, isAdapter } = agent.clientFor('gemma4:26b-a4b');
    expect(client).not.toBe(DIRECT);
    expect(client).toBe(agent.gatewayClient);
    // The Ollama client must never be handed a signal.
    expect(isAdapter).toBe(false);
  });

  it('falls back to the gateway for an unknown model rather than failing', () => {
    const agent = probe({ openaiBackend: true, directModels: ['Qwen/Qwen3.6-35B-A3B-FP8'] });
    const { client } = agent.clientFor('some-model-nobody-configured');
    expect(client).toBe(agent.gatewayClient);
  });

  it('builds the gateway client once and reuses it', () => {
    const agent = probe({ openaiBackend: true, directModels: ['Qwen/Qwen3.6-35B-A3B-FP8'] });

    const first = agent.clientFor('gemma4:26b-a4b').client;
    const second = agent.clientFor('qwen3:8b').client;
    expect(first).toBe(second);
  });
});

describe('direct-endpoint model set', () => {
  it('is seeded from lockModel, falling back to model', () => {
    const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf-8');
    expect(source).toContain('const primary = config.lockModel ?? config.model;');
    expect(source).toContain('if (primary) this.directModels.add(primary);');
  });

  it('stays empty on the gateway transport, so nothing is misrouted', () => {
    const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf-8');
    // The seeding lives inside the openai branch only.
    const openaiBranch = source.slice(
      source.indexOf("if (config.llmBackend === 'openai'"),
      source.indexOf('this.context = new ContextManager();'),
    );
    expect(openaiBranch).toContain('this.directModels.add(primary)');
  });
});

describe('chat request construction', () => {
  it('builds one request shape shared by every attempt', () => {
    const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf-8');
    // Originally there were two call sites — first attempt and the one retry —
    // and this asserted both went through chatRequest() so the retry could not
    // drop the abort signal and orphan a stream on vLLM. The retry is now a
    // loop over `retryDecision`, so there is exactly ONE call site and the
    // property holds by construction: every attempt is the same expression.
    const calls = source.match(/chatClient\.chat\(chatRequest\(\) as never\)/g) || [];
    expect(calls.length).toBe(1);
    expect(source).toContain('retryDecision(err, attempt)');
    expect(source).toContain('isAdapter && this.abortController');
    // An interrupt is not a transport fault and must never be retried.
    expect(source).toContain('if (this.abortController?.signal.aborted) throw err;');
  });
});
