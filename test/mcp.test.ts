import { describe, it, expect } from 'vitest';

describe('MCP server stderr', () => {
  it('echoes errors to the terminal but not routine chatter', async () => {
    const { MCP_STDERR_ALERT } = await import('../src/mcp.js');
    expect(MCP_STDERR_ALERT.test('Processing request of type ListToolsRequest')).toBe(false);
    expect(MCP_STDERR_ALERT.test('INFO Processing request of type CallToolRequest')).toBe(false);
    expect(MCP_STDERR_ALERT.test('Traceback (most recent call last):')).toBe(true);
    expect(MCP_STDERR_ALERT.test('ssh: connect to host 10.0.153.71 port 22: Connection refused')).toBe(true);
  });
});
