import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadAgentDefinitions } from '../src/agents.js';

let home: string; let proj: string; const savedHome = process.env.HOME;
const agent = (dir: string, file: string, body: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, file), body); };
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ag-home-')); proj = mkdtempSync(join(tmpdir(), 'ag-proj-')); process.env.HOME = home; });
afterEach(() => { process.env.HOME = savedHome; rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); });

describe('loadAgentDefinitions', () => {
  it('reads Claude Code agents unchanged, mapping tool names and ignoring Claude models', () => {
    agent(join(home, '.claude', 'agents'), 'auditor.md', '---\nname: auditor\ndescription: Reviews things.\ntools: Bash, Read, Grep, Glob, WebFetch\nmodel: opus\n---\nYou audit.\n');
    const [a] = loadAgentDefinitions(proj);
    expect(a).toMatchObject({ name: 'auditor', description: 'Reviews things.', tools: ['bash', 'read_file', 'grep', 'glob', 'web_fetch'], model: undefined, instructions: 'You audit.' });
  });

  it('keeps a fleet model, and a project agent wins over a global one of the same name', () => {
    agent(join(home, '.veepee-code', 'agents'), 'reviewer.md', '---\nname: reviewer\ndescription: global\nmodel: qwen3:8b\n---\nglobal body');
    agent(join(proj, '.veepee', 'agents'), 'reviewer.md', '---\nname: reviewer\ndescription: project\nmodel: gemma4:26b-a4b\ntools: [read_file, grep]\n---\nproject body');
    const defs = loadAgentDefinitions(proj);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ description: 'project', model: 'gemma4:26b-a4b', tools: ['read_file', 'grep'], instructions: 'project body' });
  });

  it('tools: [] means no tools, not the defaults', () => {
    agent(join(proj, '.veepee', 'agents'), 'poet.md', '---\nname: poet\ntools: []\n---\nWrite haiku.');
    expect(loadAgentDefinitions(proj)[0].tools).toEqual([]);
  });

  it('uses the file name when there is no name, and default tools when none are listed', () => {
    agent(join(proj, '.veepee', 'agents'), 'helper.md', 'Just instructions, no front matter.');
    expect(loadAgentDefinitions(proj)[0]).toMatchObject({ name: 'helper', tools: undefined, instructions: 'Just instructions, no front matter.' });
  });
});
