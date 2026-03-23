import { describe, it, expect, vi } from 'vitest';
import { MoeEngine } from '../src/moe.js';
import type { MoeStrategy } from '../src/moe.js';
import type { Config } from '../src/config.js';
import type { ModelRoster } from '../src/benchmark.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    proxyUrl: 'http://localhost:11434',
    dashboardUrl: '',
    model: null,
    autoSwitch: true,
    maxModelSize: 40,
    minModelSize: 12,
    apiPort: 8484,
    apiHost: '0.0.0.0',
    apiToken: null,
    apiExecute: false,
    searxngUrl: null,
    progressBar: true,
    modelStick: false,
    sync: null,
    rc: null,
    remote: null,
    ...overrides,
  };
}

function makeRoster(overrides: Partial<ModelRoster> = {}): ModelRoster {
  return {
    act: 'model-act',
    plan: 'model-plan',
    code: 'model-code',
    chat: 'model-chat',
    search: 'model-search',
    ...overrides,
  };
}

// ── Strategy detection (tested indirectly via MoeEngine.run) ─────
// detectStrategy is not exported, so we test it indirectly by
// observing which strategy the engine reports via onProgress.

// We mock the Ollama module to avoid real network calls.
// The chat() method must return an async iterable (the code does `for await`).
function createMockAsyncIterable() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { message: { content: 'mock response' } };
    },
  };
}

const mockChat = vi.fn().mockImplementation(() => Promise.resolve(createMockAsyncIterable()));

vi.mock('ollama', () => {
  class MockOllama {
    constructor(_opts: unknown) {}
    chat = mockChat;
  }
  return { Ollama: MockOllama };
});

async function detectStrategyViaRun(message: string): Promise<string> {
  const config = makeConfig();
  const roster = makeRoster();
  const engine = new MoeEngine(config, roster);

  let detectedStrategy = '';
  const onProgress = (model: string, role: string, status: string, content?: string) => {
    if (model === 'system' && role === 'MoE' && status === 'started' && content) {
      const match = content.match(/Strategy:\s+(\w+)/);
      if (match) detectedStrategy = match[1];
    }
  };

  try {
    await engine.run(message, 'system prompt', [], 'auto', onProgress);
  } catch {
    // Ollama mock may cause iteration errors; we only need the onProgress call
  }

  return detectedStrategy;
}

describe('Strategy detection (via MoeEngine.run auto mode)', () => {
  it('detects debate for "should we use microservices"', async () => {
    expect(await detectStrategyViaRun('should we use microservices')).toBe('debate');
  });

  it('detects debate for "review this approach"', async () => {
    expect(await detectStrategyViaRun('review this approach')).toBe('debate');
  });

  it('detects debate for "compare these two strategies"', async () => {
    expect(await detectStrategyViaRun('compare these two strategies')).toBe('debate');
  });

  it('detects debate for "what are the pros and cons"', async () => {
    expect(await detectStrategyViaRun('what are the pros and cons')).toBe('debate');
  });

  it('detects debate for "best way to do this"', async () => {
    expect(await detectStrategyViaRun('best way to do this')).toBe('debate');
  });

  it('detects debate for "evaluate this design"', async () => {
    expect(await detectStrategyViaRun('evaluate this design')).toBe('debate');
  });

  it('detects debate for "recommend a library"', async () => {
    expect(await detectStrategyViaRun('recommend a library')).toBe('debate');
  });

  it('detects fastest for "what is a promise"', async () => {
    expect(await detectStrategyViaRun('what is a promise')).toBe('fastest');
  });

  it('detects fastest for "explain async/await"', async () => {
    expect(await detectStrategyViaRun('explain async/await')).toBe('fastest');
  });

  it('detects fastest for "how does React render"', async () => {
    expect(await detectStrategyViaRun('how does React render')).toBe('fastest');
  });

  it('detects fastest for "where is the config file"', async () => {
    expect(await detectStrategyViaRun('where is the config file')).toBe('fastest');
  });

  it('detects fastest for "show me the types"', async () => {
    expect(await detectStrategyViaRun('show me the types')).toBe('fastest');
  });

  it('detects fastest for "tell me about this function"', async () => {
    expect(await detectStrategyViaRun('tell me about this function')).toBe('fastest');
  });

  it('detects fastest for bare shell commands like "ls -la"', async () => {
    expect(await detectStrategyViaRun('ls -la')).toBe('fastest');
  });

  it('detects fastest for "git status"', async () => {
    expect(await detectStrategyViaRun('git status')).toBe('fastest');
  });

  it('detects synthesize for "fix the bug in parser.ts"', async () => {
    expect(await detectStrategyViaRun('fix the bug in parser.ts')).toBe('synthesize');
  });

  it('detects synthesize for "write a function to sort items"', async () => {
    expect(await detectStrategyViaRun('write a function to sort items')).toBe('synthesize');
  });

  it('detects synthesize for "create a new component"', async () => {
    expect(await detectStrategyViaRun('create a new component')).toBe('synthesize');
  });

  it('detects synthesize for "implement the API endpoint"', async () => {
    expect(await detectStrategyViaRun('implement the API endpoint')).toBe('synthesize');
  });

  it('detects synthesize for "refactor the database layer"', async () => {
    expect(await detectStrategyViaRun('refactor the database layer')).toBe('synthesize');
  });

  it('detects synthesize for "update the config handling"', async () => {
    expect(await detectStrategyViaRun('update the config handling')).toBe('synthesize');
  });

  it('detects synthesize for "convert to TypeScript"', async () => {
    expect(await detectStrategyViaRun('convert to TypeScript')).toBe('synthesize');
  });

  it('defaults to synthesize for ambiguous messages', async () => {
    expect(await detectStrategyViaRun('hello there')).toBe('synthesize');
  });

  it('defaults to synthesize for empty-ish messages', async () => {
    expect(await detectStrategyViaRun('hmm')).toBe('synthesize');
  });

  // Debate patterns take priority over others (tested first in else-if)
  it('debate wins over synthesize when both patterns match: "should we refactor"', async () => {
    // "should we" = debate, "refactor" = synthesize — debate checked first
    expect(await detectStrategyViaRun('should we refactor the code')).toBe('debate');
  });

  it('debate wins over fastest when both patterns match: "what is the best way"', async () => {
    // "what is" = fastest, "best way" = debate — debate checked first
    expect(await detectStrategyViaRun('what is the best way to do this')).toBe('debate');
  });

  // Explicit strategy override
  it('uses explicit strategy when not auto', async () => {
    const config = makeConfig();
    const engine = new MoeEngine(config, makeRoster());

    let detectedStrategy = '';
    const onProgress = (_m: string, _r: string, status: string, content?: string) => {
      if (status === 'started' && content?.includes('Strategy:')) {
        const match = content.match(/Strategy:\s+(\w+)/);
        if (match) detectedStrategy = match[1];
      }
    };

    try {
      await engine.run('what is a promise', 'sys', [], 'synthesize', onProgress);
    } catch {}

    expect(detectedStrategy).toBe('synthesize');
  });
});

// ── MoeEngine constructor & model panel ──────────────────────────

describe('MoeEngine constructor', () => {
  it('builds 3 models from a full distinct roster', () => {
    const config = makeConfig();
    const roster = makeRoster();
    const engine = new MoeEngine(config, roster);
    const models = engine.getModels();

    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({ name: 'model-plan', role: 'Thinker' });
    expect(models[1]).toEqual({ name: 'model-code', role: 'Code Specialist' });
    expect(models[2]).toEqual({ name: 'model-search', role: 'Fast Responder' });
  });

  it('fills from chat and act when roster has duplicates', () => {
    const config = makeConfig();
    // plan, code, search are all the same model — only 1 unique
    const roster = makeRoster({
      plan: 'same-model',
      code: 'same-model',
      search: 'same-model',
      chat: 'chat-model',
      act: 'act-model',
    });
    const engine = new MoeEngine(config, roster);
    const models = engine.getModels();

    expect(models).toHaveLength(3);
    expect(models.map(m => m.name)).toContain('same-model');
    expect(models.map(m => m.name)).toContain('chat-model');
    expect(models.map(m => m.name)).toContain('act-model');
  });

  it('uses fallback defaults when roster is null', () => {
    const config = makeConfig();
    const engine = new MoeEngine(config, null);
    const models = engine.getModels();

    expect(models).toHaveLength(3);
    expect(models[0].role).toBe('Thinker');
    expect(models[1].role).toBe('Code Specialist');
    expect(models[2].role).toBe('Fast Responder');
    // Default model names
    expect(models[0].name).toBe('qwen3.5:35b');
    expect(models[1].name).toBe('qwen2.5-coder:32b-instruct');
    expect(models[2].name).toBe('qwen3:8b');
  });

  it('uses fallback defaults when roster has all nulls', () => {
    const config = makeConfig();
    const roster: ModelRoster = {
      act: null,
      plan: null,
      code: null,
      chat: null,
      search: null,
    };
    const engine = new MoeEngine(config, roster);
    const models = engine.getModels();

    // All nulls => 0 added from roster => falls back
    expect(models).toHaveLength(3);
    expect(models[0].name).toBe('qwen3.5:35b');
  });

  it('uses fallback when roster yields only 1 unique model', () => {
    const config = makeConfig();
    const roster = makeRoster({
      plan: 'only-model',
      code: 'only-model',
      search: 'only-model',
      chat: 'only-model',
      act: 'only-model',
    });
    const engine = new MoeEngine(config, roster);
    const models = engine.getModels();

    // Only 1 unique model from roster < 2, so falls back to defaults
    expect(models).toHaveLength(3);
    expect(models[0].name).toBe('qwen3.5:35b');
  });

  it('keeps 2 models without fallback when roster provides exactly 2 unique', () => {
    const config = makeConfig();
    const roster = makeRoster({
      plan: 'model-a',
      code: 'model-b',
      search: 'model-a',
      chat: 'model-a',
      act: 'model-b',
    });
    const engine = new MoeEngine(config, roster);
    const models = engine.getModels();

    // 2 unique models >= 2, no fallback
    expect(models).toHaveLength(2);
    expect(models.map(m => m.name)).toEqual(['model-a', 'model-b']);
  });

  it('assigns correct roles: plan=Thinker, code=Code Specialist, search=Fast Responder', () => {
    const config = makeConfig();
    const roster = makeRoster();
    const engine = new MoeEngine(config, roster);
    const models = engine.getModels();

    const thinker = models.find(m => m.role === 'Thinker');
    const coder = models.find(m => m.role === 'Code Specialist');
    const fast = models.find(m => m.role === 'Fast Responder');

    expect(thinker?.name).toBe('model-plan');
    expect(coder?.name).toBe('model-code');
    expect(fast?.name).toBe('model-search');
  });

  it('getModels returns a copy (not the internal array)', () => {
    const config = makeConfig();
    const engine = new MoeEngine(config, makeRoster());
    const models1 = engine.getModels();
    const models2 = engine.getModels();

    expect(models1).not.toBe(models2);
    expect(models1).toEqual(models2);
  });

  it('constructs without error using a custom proxyUrl', () => {
    const config = makeConfig({ proxyUrl: 'http://custom:9999' });
    const engine = new MoeEngine(config, makeRoster());
    // If the Ollama constructor received the config, the engine works
    expect(engine.getModels()).toHaveLength(3);
  });
});
