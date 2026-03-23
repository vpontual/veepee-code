import { describe, it, expect } from 'vitest';

// api.ts exports only startApiServer(), which requires a full Agent + ModelManager + ToolRegistry.
// The helper functions readBody, sendJson, and MAX_BODY_SIZE are not exported.
// We can only verify the module loads correctly and the export shape.

describe('api module', () => {
  it('exports startApiServer function', async () => {
    const mod = await import('../src/api.js');
    expect(mod.startApiServer).toBeDefined();
    expect(typeof mod.startApiServer).toBe('function');
  });

  it('startApiServer is the only named export', async () => {
    const mod = await import('../src/api.js');
    const exportNames = Object.keys(mod);
    expect(exportNames).toContain('startApiServer');
    // No other exports expected
    expect(exportNames.length).toBe(1);
  });
});

// Note: Full integration tests for the API server would require mocking Agent, ModelManager,
// and ToolRegistry. The readBody and sendJson helpers are private (not exported), so they
// cannot be tested directly. A future improvement would be to export them or extract into
// a separate utility module.
