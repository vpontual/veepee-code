import { describe, it, expect } from 'vitest';
import { SubAgentManager } from '../src/subagent.js';
import { ToolRegistry } from '../src/tools/registry.js';

/**
 * The `task` tool was not degraded — it was dead, and it failed in the one shape
 * nobody investigates: a policy refusal.
 *
 * `benchmarks/roster.json` still names models retired months ago
 * (`qwen3-coder-next:latest`, `gemma3:4b`). `defaultTaskModel()` returned one,
 * `subagent.allowedModels` rejected it, and every spawn died with "Model X not
 * in subagent allowedModels" — which reads as a deliberate configuration choice
 * rather than a stale file.
 */
function mgr(roster: Record<string, string> | null, allowed: string[], parentModel: string): SubAgentManager {
  const config = { proxyUrl: 'http://127.0.0.1:9', subagent: { allowedModels: allowed, maxConcurrent: 2 } };
  const m = new SubAgentManager(config as never, new ToolRegistry(), roster as never);
  m.setDefaultModel(parentModel);
  return m;
}

describe('a stale roster cannot disable the task tool', () => {
  const pick = (m: SubAgentManager) => (m as unknown as { defaultTaskModel(): string }).defaultTaskModel();

  it('is not refused for naming a model nobody asked for', async () => {
    const m = mgr({ act: 'qwen3-coder-next:latest' },
      ['Qwen/Qwen3.6-35B-A3B-FP8', 'gemma4:26b-a4b'], 'Qwen/Qwen3.6-35B-A3B-FP8');
    const { result } = await m.runTask({ prompt: 'say hi', maxTurns: 1 });
    expect(result?.error ?? '').not.toContain('not in subagent allowedModels');
  });

  it('uses a roster entry when it is allowed AND on other hardware', () => {
    const m = mgr({ act: 'gemma4:26b-a4b' },
      ['gemma4:26b-a4b', 'Qwen/Qwen3.6-35B-A3B-FP8'], 'Qwen/Qwen3.6-35B-A3B-FP8');
    expect(pick(m)).toBe('gemma4:26b-a4b');
  });

  it('NEVER routes a subagent onto the parent\'s own model', () => {
    // The DGX serves one model with a KV cache sized for it. A second
    // concurrent generation of that model there is not slow, it is a crash —
    // so the obvious fallback is the one that takes the box down.
    const m = mgr({ act: 'Qwen/Qwen3.6-35B-A3B-FP8' },
      ['Qwen/Qwen3.6-35B-A3B-FP8', 'gemma4:26b-a4b', 'qwen3:8b'], 'Qwen/Qwen3.6-35B-A3B-FP8');
    expect(pick(m)).not.toBe('Qwen/Qwen3.6-35B-A3B-FP8');
    expect(['gemma4:26b-a4b', 'qwen3:8b']).toContain(pick(m));
  });

  it('offloads to another fleet model when the roster is entirely stale', () => {
    const m = mgr({ act: 'gemma3:4b', plan: 'qwen3-coder-next:latest' },
      ['Qwen/Qwen3.6-35B-A3B-FP8', 'gemma4:26b-a4b'], 'Qwen/Qwen3.6-35B-A3B-FP8');
    expect(pick(m)).toBe('gemma4:26b-a4b');
  });
});
