import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerCodingTools } from '../src/tools/coding.js';
import { toOllamaTool } from '../src/tools/types.js';

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const registry = new ToolRegistry();
    const tools = registerCodingTools();

    for (const tool of tools) {
      registry.register(tool);
    }

    expect(registry.count()).toBe(tools.length);
    expect(registry.has('read_file')).toBe(true);
    expect(registry.has('write_file')).toBe(true);
    expect(registry.has('edit_file')).toBe(true);
    expect(registry.has('glob')).toBe(true);
    expect(registry.has('grep')).toBe(true);
    expect(registry.has('bash')).toBe(true);
    expect(registry.has('git')).toBe(true);
    expect(registry.has('list_files')).toBe(true);
    expect(registry.has('update_memory')).toBe(true);
  });

  it('returns unknown tool error on missing tool', async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute('nonexistent', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('validates tool arguments with zod schema', async () => {
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools()) registry.register(tool);

    // read_file requires 'path'
    const result = await registry.execute('read_file', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid arguments');
  });

  it('converts tools to Ollama format', () => {
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools()) registry.register(tool);

    const ollamaTools = registry.toOllamaTools();
    expect(ollamaTools.length).toBe(registry.count());

    const readFile = ollamaTools.find(t => t.function?.name === 'read_file');
    expect(readFile).toBeDefined();
    expect(readFile!.type).toBe('function');
    expect(readFile!.function!.parameters.properties).toHaveProperty('path');
  });

  it('lists all tool names', () => {
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools()) registry.register(tool);

    const names = registry.names();
    expect(names).toContain('read_file');
    expect(names).toContain('update_memory');
  });
});

describe('toOllamaTool', () => {
  it('converts zod schema to Ollama tool format', () => {
    const tools = registerCodingTools();
    const readFile = tools.find(t => t.name === 'read_file')!;
    const ollama = toOllamaTool(readFile);

    expect(ollama.type).toBe('function');
    expect(ollama.function.name).toBe('read_file');
    expect(ollama.function.description).toBeTruthy();
    expect(ollama.function.parameters.type).toBe('object');
    expect(ollama.function.parameters.required).toContain('path');
  });
});

describe('Coding tools execution', () => {
  it('read_file reads existing file', async () => {
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools()) registry.register(tool);

    const result = await registry.execute('read_file', { path: 'package.json' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('veepee-code');
  });

  it('read_file fails on nonexistent file', async () => {
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools()) registry.register(tool);

    const result = await registry.execute('read_file', { path: '/nonexistent/file.txt' });
    expect(result.success).toBe(false);
  });

  it('glob finds files', async () => {
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools()) registry.register(tool);

    const result = await registry.execute('glob', { pattern: '*.json' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('package.json');
  });

  it('list_files lists current directory', async () => {
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools()) registry.register(tool);

    const result = await registry.execute('list_files', {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('src/');
    expect(result.output).toContain('package.json');
  });

  it('update_memory tool exists and accepts args', async () => {
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools()) registry.register(tool);

    const result = await registry.execute('update_memory', { key: 'fact', value: 'test' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Stored');
  });

  it('git status works', async () => {
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools()) registry.register(tool);

    const result = await registry.execute('git', { args: 'status' });
    expect(result.success).toBe(true);
  });
});
