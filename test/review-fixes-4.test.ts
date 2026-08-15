import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { z } from 'zod';
import { parseFrontmatter } from '../src/frontmatter.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDef } from '../src/tools/types.js';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8');

describe('shared frontmatter parser', () => {
  it('parses a normal file', () => {
    const { meta, body } = parseFrontmatter('---\nname: deploy\ndescription: Ship it\n---\nBody here.\n');
    expect(meta.name).toBe('deploy');
    expect(meta.description).toBe('Ship it');
    expect(body.trim()).toBe('Body here.');
  });

  it('handles CRLF without leaving carriage returns in values', () => {
    // All three copies of this parser mishandled CRLF: `name: deploy\r` parsed
    // as "deploy\r", which then matched no lookup.
    const { meta, body } = parseFrontmatter('---\r\nname: deploy\r\ndescription: "Ship it"\r\n---\r\nBody.\r\n');
    expect(meta.name).toBe('deploy');
    expect(meta.name).not.toContain('\r');
    // Quote stripping also failed on CRLF, because the last char was \r.
    expect(meta.description).toBe('Ship it');
    expect(body).not.toContain('\r');
  });

  it('strips matching quotes but leaves a lone quote alone', () => {
    expect(parseFrontmatter('---\na: "x"\nb: \'y\'\nc: "\n---\n').meta).toEqual({ a: 'x', b: 'y', c: '"' });
  });

  it('returns the whole input as body when there is no frontmatter', () => {
    const { meta, body } = parseFrontmatter('no frontmatter here');
    expect(meta).toEqual({});
    expect(body).toBe('no frontmatter here');
  });

  it('reads a folded block scalar as one paragraph, not the literal ">"', () => {
    // How Omarchy (and Claude Code) write skill descriptions. The line-based
    // parser recorded ">" as the description and turned every indented line
    // holding a colon — "Triggers: crash, segfault" — into its own bogus key,
    // so the skill reached the index with no usable description at all.
    const { meta } = parseFrontmatter([
      '---',
      'name: diagnose-crash',
      'description: >',
      '  Diagnose why a program crashed.',
      '  Triggers: crash, segfault, SIGSEGV.',
      'model: opus',
      '---',
      'Body.',
    ].join('\n'));
    expect(meta.description).toBe('Diagnose why a program crashed. Triggers: crash, segfault, SIGSEGV.');
    expect(meta.name).toBe('diagnose-crash');
    expect(meta.model).toBe('opus');
    expect(meta).not.toHaveProperty('Triggers');
  });

  it('keeps blank lines in a folded scalar as paragraph breaks', () => {
    const { meta } = parseFrontmatter('---\ndescription: >\n  one\n  two\n\n  three\n---\nBody.');
    expect(meta.description).toBe('one two\nthree');
  });

  it('keeps every line of a literal block scalar', () => {
    const { meta } = parseFrontmatter('---\nusage: |\n  vcode --eval\n  vcode --repeat 3\n---\nBody.');
    expect(meta.usage).toBe('vcode --eval\nvcode --repeat 3');
  });

  it('accepts chomping and indentation indicators', () => {
    expect(parseFrontmatter('---\na: |-\n  x\n---\n').meta.a).toBe('x');
    expect(parseFrontmatter('---\na: >2\n  x\n---\n').meta.a).toBe('x');
  });

  it('treats text after the indicator as a plain value, as YAML does', () => {
    // `a: > b` is a string in YAML, not a block header. Reading it as a block
    // would swallow the following key.
    const { meta } = parseFrontmatter('---\na: > b\nb: kept\n---\n');
    expect(meta.a).toBe('> b');
    expect(meta.b).toBe('kept');
  });

  it('ends a block scalar at the next key, not at the end of the frontmatter', () => {
    const { meta } = parseFrontmatter('---\ndescription: >\n  folded text\nname: after\n---\nBody.');
    expect(meta.description).toBe('folded text');
    expect(meta.name).toBe('after');
  });

  it('is the only copy — skills, user-commands and output-styles share it', () => {
    for (const f of ['../src/skills.ts', '../src/user-commands.ts', '../src/output-styles.ts']) {
      const src = read(f);
      expect(src, f).toContain("from './frontmatter.js'");
      expect(src, f).not.toContain('function parseFrontmatter(');
    }
  });
});

describe('per-tool execution budget', () => {
  const makeTool = (over: Partial<ToolDef>): ToolDef => ({
    name: 'slow',
    description: 'test',
    schema: z.object({}),
    execute: async () => new Promise(() => { /* never settles */ }),
    ...over,
  });

  it('abandons a hung tool instead of blocking the agent forever', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ timeoutMs: 150 }));
    const started = Date.now();
    const res = await reg.execute('slow', {});
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/budget/i);
  });

  it('lets an opted-out tool run unbounded', async () => {
    const reg = new ToolRegistry();
    let resolveIt: (v: unknown) => void = () => {};
    reg.register(makeTool({
      name: 'longrunner',
      timeoutMs: null,
      execute: () => new Promise((r) => { resolveIt = r as (v: unknown) => void; }) as Promise<never>,
    }));
    const p = reg.execute('longrunner', {});
    await new Promise((r) => setTimeout(r, 100));
    resolveIt({ success: true, output: 'done' });
    await expect(p).resolves.toMatchObject({ success: true, output: 'done' });
  });

  it('does not interfere with a tool that finishes normally', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({
      name: 'quick',
      timeoutMs: 5000,
      execute: async () => ({ success: true, output: 'ok' }),
    }));
    await expect(reg.execute('quick', {})).resolves.toMatchObject({ success: true, output: 'ok' });
  });

  it('exempts the genuinely long-running tools', () => {
    expect(read('../src/tools/task.ts')).toContain('timeoutMs: null');
    expect(read('../src/deep-research.ts')).toContain('timeoutMs: null');
  });
});

describe('worktree metadata is not fabricated', () => {
  it('reports an unknown base branch rather than the caller\'s current one', () => {
    const src = read('../src/worktree.ts');
    // Scope to the LISTING path. createWorktree legitimately records both —
    // it is the thing doing the creating. `git worktree list` reports neither,
    // and filling them in made every listed worktree claim it branched from
    // wherever the user happened to be standing, created this instant.
    const listing = src.slice(src.indexOf('export function listWorktrees'));
    expect(listing).toContain('baseBranch: null');
    expect(listing).not.toContain('baseBranch: getCurrentBranch(cwd)');
    expect(listing).not.toContain('created: new Date()');
    // The creation path still records real values.
    const creation = src.slice(src.indexOf('export function createWorktree'), src.indexOf('export function listWorktrees'));
    expect(creation).toContain('created: new Date()');
  });

  it('always ignores the worktree directory, not only when it just created it', () => {
    const src = read('../src/worktree.ts');
    const guard = src.indexOf('if (!existsSync(worktreeBase))');
    const ignore = src.indexOf("resolve(cwd, '.gitignore')");
    expect(guard).toBeGreaterThan(-1);
    expect(ignore).toBeGreaterThan(guard); // outside the creation branch
  });
});

describe('dead code removed', () => {
  it('drops the unreferenced VirtualMessageList', () => {
    // It was never imported anywhere and had no tests, while the live renderer
    // solved the same problem via memoisation.
    let existed = true;
    try { read('../src/tui/components/VirtualMessageList.tsx'); } catch { existed = false; }
    expect(existed).toBe(false);
  });
});

describe('benchmark context probe', () => {
  it('only records maxUsable when the answer was correct', () => {
    const src = read('../src/benchmark.ts');
    expect(src).toContain('if (isCorrect) {\n          maxUsable = ctxSize;');
  });

  it('does not treat a transient network error as a context ceiling', () => {
    const src = read('../src/benchmark.ts');
    expect(src).toContain('const transient =');
    expect(src).toContain('probeErrors.push');
  });
});
