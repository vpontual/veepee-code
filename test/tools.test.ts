import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerCodingTools } from '../src/tools/coding.js';
import { toOllamaTool } from '../src/tools/types.js';
import { FileTracker } from '../src/filetracker.js';

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
    expect(registry.has('multi_edit')).toBe(true);
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
    expect(result.success || result.error?.includes('EPERM')).toBe(true);
  });
});

describe('FileTracker integration with edit_file / write_file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcode-tools-tracker-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('edit_file refuses a file the agent never read', async () => {
    const tracker = new FileTracker();
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, tracker)) registry.register(tool);

    const p = join(dir, 'a.txt');
    writeFileSync(p, 'hello world\n');

    const result = await registry.execute('edit_file', {
      path: p,
      old_string: 'hello',
      new_string: 'goodbye',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('was not read in this session');
    expect(readFileSync(p, 'utf-8')).toBe('hello world\n');
  });

  it('edit_file refuses a file modified on disk after read', async () => {
    const tracker = new FileTracker();
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, tracker)) registry.register(tool);

    const p = join(dir, 'a.txt');
    writeFileSync(p, 'hello world\n');

    // Read the file (records timestamp)
    const readResult = await registry.execute('read_file', { path: p });
    expect(readResult.success).toBe(true);

    // Bump mtime into the future
    const future = new Date(Date.now() + 60_000);
    utimesSync(p, future, future);

    const result = await registry.execute('edit_file', {
      path: p,
      old_string: 'hello',
      new_string: 'goodbye',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('modified on disk after you last read it');
    expect(readFileSync(p, 'utf-8')).toBe('hello world\n');
  });

  it('edit_file succeeds when the file is fresh', async () => {
    const tracker = new FileTracker();
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, tracker)) registry.register(tool);

    const p = join(dir, 'a.txt');
    writeFileSync(p, 'hello world\n');

    await registry.execute('read_file', { path: p });
    const result = await registry.execute('edit_file', {
      path: p,
      old_string: 'hello',
      new_string: 'goodbye',
    });
    expect(result.success).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('goodbye world\n');
  });

  it('write_file allows creating a brand-new file', async () => {
    const tracker = new FileTracker();
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, tracker)) registry.register(tool);

    const p = join(dir, 'new.txt');
    const result = await registry.execute('write_file', { path: p, content: 'fresh\n' });
    expect(result.success).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('fresh\n');
  });

  it('write_file refuses overwrite of a stale existing file', async () => {
    const tracker = new FileTracker();
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, tracker)) registry.register(tool);

    const p = join(dir, 'a.txt');
    writeFileSync(p, 'v1\n');
    await registry.execute('read_file', { path: p });
    const future = new Date(Date.now() + 60_000);
    utimesSync(p, future, future);

    const result = await registry.execute('write_file', { path: p, content: 'v2\n' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('modified on disk');
    expect(readFileSync(p, 'utf-8')).toBe('v1\n');
  });

  it('bash command mentioning a tracked file forgets it', async () => {
    const tracker = new FileTracker();
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, tracker)) registry.register(tool);

    const p = join(dir, 'sed-target.txt');
    writeFileSync(p, 'before\n');
    await registry.execute('read_file', { path: p });
    expect(tracker.size()).toBe(1);

    // A bash command that just references the file by basename should clear it.
    const result = await registry.execute('bash', { command: `echo skipping sed-target.txt` });
    expect(result.success).toBe(true);
    expect(tracker.size()).toBe(0);
  });

  it('bash command not mentioning the file does not forget tracked entries', async () => {
    const tracker = new FileTracker();
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, tracker)) registry.register(tool);

    const p = join(dir, 'kept.txt');
    writeFileSync(p, 'data\n');
    await registry.execute('read_file', { path: p });
    expect(tracker.size()).toBe(1);

    const result = await registry.execute('bash', { command: 'echo unrelated' });
    expect(result.success).toBe(true);
    expect(tracker.size()).toBe(1);
  });
});

describe('multi_edit', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcode-multiedit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(): { registry: ToolRegistry; tracker: FileTracker } {
    const tracker = new FileTracker();
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, tracker)) registry.register(tool);
    return { registry, tracker };
  }

  it('applies all edits atomically when each one matches', async () => {
    const { registry } = setup();
    const p = join(dir, 'src.ts');
    writeFileSync(p, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    await registry.execute('read_file', { path: p });

    const result = await registry.execute('multi_edit', {
      path: p,
      edits: [
        { old_string: 'const a = 1;', new_string: 'const a = 10;' },
        { old_string: 'const b = 2;', new_string: 'const b = 20;' },
        { old_string: 'const c = 3;', new_string: 'const c = 30;' },
      ],
    });
    expect(result.success).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('const a = 10;\nconst b = 20;\nconst c = 30;\n');
    expect(result.output).toContain('applied 3 edits');
  });

  it('writes nothing when any op would fail', async () => {
    const { registry } = setup();
    const p = join(dir, 'src.ts');
    const original = 'foo\nbar\nbaz\n';
    writeFileSync(p, original);
    await registry.execute('read_file', { path: p });

    const result = await registry.execute('multi_edit', {
      path: p,
      edits: [
        { old_string: 'foo', new_string: 'FOO' },
        { old_string: 'NOT_PRESENT', new_string: 'X' }, // fails
        { old_string: 'baz', new_string: 'BAZ' },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('op 1 failed');
    expect(result.error).toContain('1/3 edits would succeed');
    // No partial write — file is untouched.
    expect(readFileSync(p, 'utf-8')).toBe(original);
  });

  it('applies edits sequentially so later edits can see earlier ones', async () => {
    const { registry } = setup();
    const p = join(dir, 'src.ts');
    writeFileSync(p, 'const oldName = 1;\noldName + 2;\n');
    await registry.execute('read_file', { path: p });

    // First op renames; second op only succeeds against the renamed content.
    const result = await registry.execute('multi_edit', {
      path: p,
      edits: [
        { old_string: 'const oldName = 1;', new_string: 'const newName = 1;' },
        { old_string: 'oldName + 2;', new_string: 'newName + 2;' },
      ],
    });
    expect(result.success).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('const newName = 1;\nnewName + 2;\n');
  });

  it('refuses on a stale file (file modified on disk after read)', async () => {
    const { registry, tracker } = setup();
    const p = join(dir, 'src.ts');
    writeFileSync(p, 'foo\n');
    await registry.execute('read_file', { path: p });
    const future = new Date(Date.now() + 60_000);
    utimesSync(p, future, future);

    const result = await registry.execute('multi_edit', {
      path: p,
      edits: [{ old_string: 'foo', new_string: 'bar' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('modified on disk');
    expect(readFileSync(p, 'utf-8')).toBe('foo\n');
    expect(tracker.size()).toBe(1); // tracker entry preserved
  });

  it('respects replace_all per edit', async () => {
    const { registry } = setup();
    const p = join(dir, 'src.ts');
    writeFileSync(p, 'foo foo foo\nbar bar\n');
    await registry.execute('read_file', { path: p });

    const result = await registry.execute('multi_edit', {
      path: p,
      edits: [
        { old_string: 'foo', new_string: 'X', replace_all: true },
        { old_string: 'bar bar', new_string: 'YY' }, // unique, no replace_all needed
      ],
    });
    expect(result.success).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('X X X\nYY\n');
  });

  it('fails with a clear error when a non-replace_all edit matches multiple times', async () => {
    const { registry } = setup();
    const p = join(dir, 'src.ts');
    writeFileSync(p, 'foo\nfoo\n');
    await registry.execute('read_file', { path: p });

    const result = await registry.execute('multi_edit', {
      path: p,
      edits: [{ old_string: 'foo', new_string: 'bar' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('found 2 times');
    expect(readFileSync(p, 'utf-8')).toBe('foo\nfoo\n');
  });
});
