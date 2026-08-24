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
  it('falls back to the parent model when the roster names a retired one', async () => {
    const m = mgr({ act: 'qwen3-coder-next:latest' }, ['Qwen/Qwen3.6-35B-A3B-FP8'], 'Qwen/Qwen3.6-35B-A3B-FP8');
    const { result } = await m.runTask({ prompt: 'say hi', maxTurns: 1 });
    // It must not be refused for naming a model nobody asked for.
    expect(result?.error ?? '').not.toContain('not in subagent allowedModels');
  });

  it('uses a roster entry when it IS allowed', () => {
    const m = mgr({ act: 'gemma4:26b-a4b' }, ['gemma4:26b-a4b', 'Qwen/Qwen3.6-35B-A3B-FP8'], 'Qwen/Qwen3.6-35B-A3B-FP8');
    expect((m as unknown as { defaultTaskModel(): string }).defaultTaskModel()).toBe('gemma4:26b-a4b');
  });

  it('prefers the parent model over any retired roster entry', () => {
    const m = mgr({ act: 'gemma3:4b', plan: 'qwen3-coder-next:latest' }, ['Qwen/Qwen3.6-35B-A3B-FP8'], 'Qwen/Qwen3.6-35B-A3B-FP8');
    expect((m as unknown as { defaultTaskModel(): string }).defaultTaskModel()).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
  });
});
