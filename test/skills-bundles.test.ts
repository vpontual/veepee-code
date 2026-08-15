import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadSkills, buildSkillInvokeTool } from '../src/skills.js';

/**
 * Regression: vcode only ever saw flat `<name>.md` skills. Every other agent —
 * Claude Code, Codex, Pi — and Omarchy's own `default/agents/skills` ship the
 * `<name>/SKILL.md` bundle layout, which `readdirSync` handed to a
 * `.endsWith('.md')` filter that dropped it without a word. Omarchy symlinks
 * its skills into each agent's skills directory on provision, so on a Quattro
 * box the omarchy skill was present on disk and invisible to vcode.
 */

let home: string;
let cwd: string;
const realHome = process.env.HOME;

const skill = (dir: string, file: string, content: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vcode-skills-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'vcode-skills-cwd-'));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const globalSkills = () => join(home, '.veepee-code', 'skills');

describe('skill discovery', () => {
  it('still loads a flat <name>.md', () => {
    skill(globalSkills(), 'deploy.md', '---\nname: deploy\ndescription: Ship it\n---\nRun the script.\n');
    const skills = loadSkills(cwd);
    expect(skills.map((s) => s.name)).toEqual(['deploy']);
    expect(skills[0].content).toBe('Run the script.');
    expect(skills[0].bundleDir).toBeUndefined();
  });

  it('loads a <name>/SKILL.md bundle', () => {
    skill(join(globalSkills(), 'omarchy'), 'SKILL.md', '---\nname: omarchy\ndescription: Desktop config\n---\nBody.\n');
    const skills = loadSkills(cwd);
    expect(skills.map((s) => s.name)).toEqual(['omarchy']);
    expect(skills[0].bundleDir).toBe(resolve(globalSkills(), 'omarchy'));
  });

  it('names a bundle after its directory when the frontmatter omits a name', () => {
    skill(join(globalSkills(), 'diagnose-crash'), 'SKILL.md', '---\ndescription: Read core dumps\n---\nBody.\n');
    expect(loadSkills(cwd).map((s) => s.name)).toEqual(['diagnose-crash']);
  });

  it('follows a symlinked bundle — how Omarchy installs its skills', () => {
    const source = mkdtempSync(join(tmpdir(), 'vcode-skills-src-'));
    skill(join(source, 'omarchy'), 'SKILL.md', '---\nname: omarchy\ndescription: Desktop config\n---\nBody.\n');
    mkdirSync(globalSkills(), { recursive: true });
    symlinkSync(join(source, 'omarchy'), join(globalSkills(), 'omarchy'), 'dir');
    try {
      expect(loadSkills(cwd).map((s) => s.name)).toEqual(['omarchy']);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('ignores a directory with no SKILL.md instead of inventing a skill', () => {
    mkdirSync(join(globalSkills(), 'notes'), { recursive: true });
    writeFileSync(join(globalSkills(), 'notes', 'scratch.md'), 'just notes');
    expect(loadSkills(cwd)).toEqual([]);
  });

  it('lets a bundle win over a same-named flat file, deterministically', () => {
    skill(globalSkills(), 'omarchy.md', '---\nname: omarchy\ndescription: flat\n---\nflat body\n');
    skill(join(globalSkills(), 'omarchy'), 'SKILL.md', '---\nname: omarchy\ndescription: bundle\n---\nbundle body\n');
    const skills = loadSkills(cwd);
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('bundle');
  });

  it('keeps project skills shadowing global ones across layouts', () => {
    skill(join(globalSkills(), 'deploy'), 'SKILL.md', '---\nname: deploy\ndescription: global\n---\nglobal\n');
    skill(join(cwd, '.veepee', 'skills'), 'deploy.md', '---\nname: deploy\ndescription: project\n---\nproject\n');
    const skills = loadSkills(cwd);
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe('project');
  });
});

describe('companion files', () => {
  const buildOmarchyBundle = () => {
    const dir = join(globalSkills(), 'omarchy');
    skill(dir, 'SKILL.md', '---\nname: omarchy\ndescription: Desktop config\n---\nSee [`hyprland.md`](hyprland.md).\n');
    writeFileSync(join(dir, 'hyprland.md'), 'keybindings');
    writeFileSync(join(dir, 'theming.md'), 'themes');
    writeFileSync(join(dir, 'notes.txt'), 'not markdown');
    return dir;
  };

  it('collects sibling markdown, excluding SKILL.md and non-markdown', () => {
    const dir = buildOmarchyBundle();
    const [s] = loadSkills(cwd);
    expect(s.companions).toEqual([resolve(dir, 'hyprland.md'), resolve(dir, 'theming.md')]);
  });

  it('gives skill_invoke absolute paths, since the body links by bare name', async () => {
    const dir = buildOmarchyBundle();
    const tool = buildSkillInvokeTool(cwd);
    expect(tool).not.toBeNull();
    const result = await tool!.execute({ name: 'omarchy' });
    expect(result.success).toBe(true);
    expect(result.output).toContain(resolve(dir, 'hyprland.md'));
    expect(result.output).toContain('See [`hyprland.md`](hyprland.md).');
  });

  it('says nothing about companions for a flat skill', async () => {
    skill(globalSkills(), 'deploy.md', '---\nname: deploy\ndescription: Ship it\n---\nRun it.\n');
    const tool = buildSkillInvokeTool(cwd);
    const result = await tool!.execute({ name: 'deploy' });
    expect(result.output).not.toContain('Companion files');
  });
});
