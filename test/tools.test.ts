import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
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

  it('a read-only bash command that merely names a tracked file does NOT forget it', async () => {
    const tracker = new FileTracker();
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, tracker)) registry.register(tool);

    const p = join(dir, 'sed-target.txt');
    writeFileSync(p, 'before\n');
    await registry.execute('read_file', { path: p });
    expect(tracker.size()).toBe(1);

    // This asserted the opposite until 2026-08-24. Forgetting on any mention of
    // a basename meant `git diff public/index.html`, `node test/test.js` and
    // `sed -n '533p' file | cat -A` — all pure reads — each cost the model a
    // re-read plus a refused edit. Measured in a real sweep: 14 of 38 bash calls
    // invalidated an already-read file, and 25% of ALL re-reads trace to it.
    //
    // Safe because forgetting was never the real guard: `checkFresh` compares
    // mtime, so a file that genuinely changed is still caught.
    const result = await registry.execute('bash', { command: `echo skipping sed-target.txt` });
    expect(result.success).toBe(true);
    expect(tracker.size()).toBe(1);
  });

  it('a mutating bash command naming the file DOES forget it', async () => {
    const tracker = new FileTracker();
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, tracker)) registry.register(tool);

    const p = join(dir, 'mutated.txt');
    writeFileSync(p, 'before\n');
    await registry.execute('read_file', { path: p });
    await registry.execute('bash', { command: `sed -i 's/before/after/' ${p}` });
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
    // Names the failing op and how many were fine. The wording changed when
    // multi_edit started checking every edit instead of stopping at the first
    // failure; the guarantee this test exists for — no partial write — did not.
    expect(result.error).toContain('op 1:');
    expect(result.error).toContain('1 of 3 edits failed');
    expect(result.error).toMatch(/other 2 edits matched/);
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

describe('ToolRegistry arg coercion (Tier 3 #2)', () => {
  function makeRegistry() {
    const registry = new ToolRegistry();
    registry.register({
      name: 'toggle',
      description: 'test tool with a bool + number',
      schema: z.object({
        flag: z.boolean().optional().default(false),
        count: z.number().optional(),
        label: z.string(),
      }),
      execute: async (p) => ({ success: true, output: JSON.stringify(p) }),
    });
    return registry;
  }

  it('coerces stringified booleans the model commonly emits', async () => {
    const r = await makeRegistry().execute('toggle', { flag: 'true', label: 'x' });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output)).toMatchObject({ flag: true, label: 'x' });
  });

  it('coerces stringified numbers', async () => {
    const r = await makeRegistry().execute('toggle', { count: '5', label: 'x' });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output)).toMatchObject({ count: 5 });
  });

  it('does NOT rewrite a field that legitimately wants a string', async () => {
    const r = await makeRegistry().execute('toggle', { label: 'true' });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output)).toMatchObject({ label: 'true' });
  });

  it('returns an actionable, retry-instructing error on genuinely bad args', async () => {
    const r = await makeRegistry().execute('toggle', { flag: 'maybe', label: 42 });
    expect(r.success).toBe(false);
    expect(r.error).toContain("call toggle again");
    expect(r.error).toMatch(/'label'/);
  });
});

describe('nested argument coercion', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vcode-coerce-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const build = () => {
    const registry = new ToolRegistry();
    for (const tool of registerCodingTools(undefined, new FileTracker())) registry.register(tool);
    return registry;
  };

  it('coerces a stringified boolean inside an array of objects', async () => {
    // multi_edit's booleans live at edits[N].replace_all. Coercion used to walk
    // only the top level, so the whole call was rejected for the one mistake
    // coercion exists to absorb — a wasted turn, seen in the harness eval as
    // "'edits.0.replace_all': Expected boolean, received string".
    const registry = build();
    const p = join(dir, 'nested.ts');
    writeFileSync(p, 'a\na\nb\n');
    await registry.execute('read_file', { path: p });

    const result = await registry.execute('multi_edit', {
      path: p,
      edits: [{ old_string: 'a', new_string: 'X', replace_all: 'true' }],
    });

    expect(result.success).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('X\nX\nb\n');
  });

  it('still rejects a value that is not coercible', async () => {
    const registry = build();
    const p = join(dir, 'nested2.ts');
    writeFileSync(p, 'a\n');
    await registry.execute('read_file', { path: p });
    const result = await registry.execute('multi_edit', {
      path: p,
      edits: [{ old_string: 'a', new_string: 'X', replace_all: 'maybe' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('replace_all');
  });

  it('leaves a genuine string argument alone', async () => {
    const registry = build();
    const p = join(dir, 'nested3.ts');
    writeFileSync(p, 'true\n');
    await registry.execute('read_file', { path: p });
    // old_string is a string field whose VALUE is "true" — coercion must not
    // rewrite it into a boolean.
    const result = await registry.execute('multi_edit', {
      path: p,
      edits: [{ old_string: 'true', new_string: 'false' }],
    });
    expect(result.success).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('false\n');
  });
});
