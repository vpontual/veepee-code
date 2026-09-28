import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/tools/registry.js';
import { buildToolSearchTool } from '../src/tools/tool-search.js';
import type { ToolDef } from '../src/tools/types.js';

const tool = (name: string, description: string, sourceName = 'srv'): ToolDef => ({
  name, description, schema: z.object({}), source: 'mcp', sourceName,
  execute: async () => ({ success: true, output: name }),
});

function setup() {
  const r = new ToolRegistry();
  r.register(tool('read_file', 'Read a file', undefined));
  const mcp = [
    tool('mcp__pal__calendar_agenda', '[mcp:pal] List calendar events', 'pal'),
    tool('mcp__pal__weather', '[mcp:pal] Current weather for a city', 'pal'),
    tool('mcp__mem__recall', '[mcp:mem] Search shared memory', 'mem'),
  ];
  r.registerBatch(mcp);
  r.defer(mcp.map(t => t.name));
  return { r, search: buildToolSearchTool(r) };
}
const offered = (r: ToolRegistry) => r.toOllamaTools().map(t => t.function.name);

describe('deferred tools and tool_search', () => {
  it('leaves deferred tools out of what the model is offered, but callable', async () => {
    const { r } = setup();
    expect(offered(r)).toEqual(['read_file']);
    expect((await r.execute('mcp__pal__weather', {})).success).toBe(true);
  });

  it('describes what is waiting, per server', () => {
    expect(setup().search.description).toContain('pal (2 tools), mem (1 tools)');
  });

  it('loads matching tools by keyword, and exact ones by select:', async () => {
    const { r, search } = setup();
    const res = await search.execute({ query: 'weather in paris' });
    expect(res.output).toContain('mcp__pal__weather');
    expect(offered(r)).toContain('mcp__pal__weather');
    expect(offered(r)).not.toContain('mcp__pal__calendar_agenda');
    await search.execute({ query: 'select:recall' });
    expect(offered(r)).toContain('mcp__mem__recall');
  });

  it('says so when nothing matches', async () => {
    const { search } = setup();
    expect((await search.execute({ query: 'kubernetes' })).success).toBe(false);
  });
});
