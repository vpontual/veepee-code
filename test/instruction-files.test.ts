import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findInstructionFile, INSTRUCTION_FILENAMES, ContextManager } from '../src/context.js';
import { IgnoreManager, IGNORE_FILENAMES } from '../src/ignore.js';

let tmp: string;
let prevHome: string | undefined;
let prevCwd: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vcode-instr-'));
  prevCwd = process.cwd();
  prevHome = process.env.HOME;
  // Isolate the global slot so the developer's own files don't leak in.
  const home = join(tmp, 'home');
  mkdirSync(join(home, '.veepee-code'), { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

/** Build a project dir and return its path. */
function project(name: string, files: Record<string, string>, asRepo = true): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  if (asRepo) mkdirSync(join(dir, '.git'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

function instructionsFor(dir: string): string {
  process.chdir(dir);
  const ctx = new ContextManager();
  ctx.setSystemPrompt('some-model');
  const prompt = ctx.getSystemPrompt();
  const idx = prompt.indexOf('## Project Instructions');
  return idx < 0 ? '' : prompt.slice(idx);
}

describe('findInstructionFile', () => {
  it('prefers the vcode-specific name, then the cross-agent standard', () => {
    expect(INSTRUCTION_FILENAMES).toEqual(['VEEPEE.md', 'AGENTS.md', 'CLAUDE.md']);
    const dir = project('all-three', {
      'VEEPEE.md': 'veepee', 'AGENTS.md': 'agents', 'CLAUDE.md': 'claude',
    });
    expect(findInstructionFile(dir)?.name).toBe('VEEPEE.md');
  });

  it('falls back to AGENTS.md', () => {
    const dir = project('agents-only', { 'AGENTS.md': 'a', 'CLAUDE.md': 'c' });
    expect(findInstructionFile(dir)?.name).toBe('AGENTS.md');
  });

  it('falls back to CLAUDE.md', () => {
    const dir = project('claude-only', { 'CLAUDE.md': 'c' });
    expect(findInstructionFile(dir)?.name).toBe('CLAUDE.md');
  });

  it('returns null when a directory has none', () => {
    expect(findInstructionFile(project('bare', {}))).toBeNull();
  });
});

describe('project instruction loading', () => {
  it('loads a repo that only has CLAUDE.md — previously invisible to vcode', () => {
    const dir = project('claude-repo', { 'CLAUDE.md': 'RULE: always run the linter.' });
    const out = instructionsFor(dir);
    expect(out).toContain('RULE: always run the linter.');
    expect(out).toContain('workspace (CLAUDE.md)');
  });

  it('loads only ONE file per directory, not all three', () => {
    const dir = project('dupes', {
      'VEEPEE.md': 'FROM_VEEPEE',
      'AGENTS.md': 'FROM_AGENTS',
      'CLAUDE.md': 'FROM_CLAUDE',
    });
    const out = instructionsFor(dir);
    expect(out).toContain('FROM_VEEPEE');
    // These files are near-duplicates in practice; loading all of them wastes
    // context and invites contradictions.
    expect(out).not.toContain('FROM_AGENTS');
    expect(out).not.toContain('FROM_CLAUDE');
  });

  it('does not load the same content twice when CLAUDE.md is a symlink to AGENTS.md', () => {
    const dir = join(tmp, 'linked');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), 'SHARED_GUIDANCE');
    symlinkSync(join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md'));
    const out = instructionsFor(dir);
    expect(out.match(/SHARED_GUIDANCE/g)?.length ?? 0).toBe(1);
  });

  it('stops walking up at the repository root', () => {
    // A parent above the repo must NOT be pulled in: on a real machine that
    // reached $HOME and attached a 22KB homelab document (~7.5k tokens) to
    // every turn of every session.
    const outer = join(tmp, 'outer');
    mkdirSync(outer, { recursive: true });
    writeFileSync(join(outer, 'CLAUDE.md'), 'OUTSIDE_THE_REPO');
    const repo = join(outer, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), 'INSIDE_THE_REPO');

    const out = instructionsFor(repo);
    expect(out).toContain('INSIDE_THE_REPO');
    expect(out).not.toContain('OUTSIDE_THE_REPO');
  });

  it('still loads a parent inside the same repo', () => {
    const repo = join(tmp, 'monorepo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), 'MONOREPO_RULES');
    const pkg = join(repo, 'packages', 'api');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'AGENTS.md'), 'API_RULES');

    const out = instructionsFor(pkg);
    expect(out).toContain('MONOREPO_RULES');
    expect(out).toContain('API_RULES');
    // Workspace outranks the parent, so it is rendered last.
    expect(out.indexOf('MONOREPO_RULES')).toBeLessThan(out.indexOf('API_RULES'));
  });

  it('always loads the global slot regardless of repo boundaries', () => {
    writeFileSync(join(process.env.HOME!, '.veepee-code', 'AGENTS.md'), 'USER_WIDE_RULES');
    const dir = project('plain', { 'AGENTS.md': 'PROJECT_RULES' });
    const out = instructionsFor(dir);
    expect(out).toContain('USER_WIDE_RULES');
    expect(out).toContain('PROJECT_RULES');
    expect(out.indexOf('USER_WIDE_RULES')).toBeLessThan(out.indexOf('PROJECT_RULES'));
  });

  it('emits nothing when there are no instruction files anywhere', () => {
    expect(instructionsFor(project('empty', {}))).toBe('');
  });
});

describe('.agentignore', () => {
  it('is loaded alongside .veepeignore, additively', () => {
    expect(IGNORE_FILENAMES).toEqual(['.agentignore', '.veepeignore']);
    const dir = join(tmp, 'ig');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.agentignore'), 'private/\n');
    writeFileSync(join(dir, '.veepeignore'), 'scratch/\n');
    const m = new IgnoreManager(dir);
    expect(m.isBlocked(join(dir, 'private', 'x.txt'))).toBe(true);
    expect(m.isBlocked(join(dir, 'scratch', 'y.txt'))).toBe(true);
    expect(m.isBlocked(join(dir, 'src', 'app.ts'))).toBe(false);
  });

  it('lets .veepeignore negate a pattern from .agentignore', () => {
    const dir = join(tmp, 'ig2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.agentignore'), 'private/\n');
    writeFileSync(join(dir, '.veepeignore'), '!private/ok.txt\n');
    const m = new IgnoreManager(dir);
    expect(m.isBlocked(join(dir, 'private', 'secret.txt'))).toBe(true);
    expect(m.isBlocked(join(dir, 'private', 'ok.txt'))).toBe(false);
  });

  it('works with only .agentignore present', () => {
    const dir = join(tmp, 'ig3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.agentignore'), 'build/\n');
    const m = new IgnoreManager(dir);
    expect(m.isBlocked(join(dir, 'build', 'out.js'))).toBe(true);
  });
});
