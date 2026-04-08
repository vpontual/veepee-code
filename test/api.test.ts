import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { startApiServer } from '../src/api.js';

describe('api module', () => {
  it('exports startApiServer function', () => {
    expect(startApiServer).toBeDefined();
    expect(typeof startApiServer).toBe('function');
  });

  it('startApiServer is the only named export', async () => {
    const mod = await import('../src/api.js');
    const exportNames = Object.keys(mod);
    expect(exportNames).toContain('startApiServer');
    // No other exports expected
    expect(exportNames.length).toBe(1);
  });

  it('passes tool restrictions through per-request run options instead of shared agent state', () => {
    const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf-8');

    expect(source).toContain("allowedTools: clientToolNames");
    expect(source).not.toContain('agent.setAllowedTools(');
  });
});
