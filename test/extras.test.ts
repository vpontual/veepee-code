import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_EXTRAS, extraByName } from '../src/extras/builtins.js';
import { listExtras, activeSystemPromptSections } from '../src/extras/manager.js';

let tmp: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vcode-extras-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  originalCwd = process.cwd();
  mkdirSync(join(tmp, 'project'), { recursive: true });
  mkdirSync(join(tmp, '.veepee-code'), { recursive: true });
  process.chdir(join(tmp, 'project'));
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});

function writeSettings(s: unknown) {
  writeFileSync(join(tmp, '.veepee-code', 'settings.json'), JSON.stringify(s, null, 2));
}

describe('BUILTIN_EXTRAS', () => {
  it('every extra has a non-empty system prompt section', () => {
    for (const e of BUILTIN_EXTRAS) {
      expect(e.systemPromptSection.length).toBeGreaterThan(0);
      expect(e.lspRecipes.length).toBeGreaterThan(0);
    }
  });

  it('extraByName returns the matching extra and null for unknown', () => {
    expect(extraByName('typescript')?.lspRecipes).toContain('typescript');
    expect(extraByName('not-a-real-language')).toBeNull();
  });
});

describe('listExtras', () => {
  it('marks extras as active when listed in config.extras', () => {
    writeSettings({ extras: ['python'] });
    const items = listExtras();
    const py = items.find((i) => i.extra.name === 'python');
    const ts = items.find((i) => i.extra.name === 'typescript');
    expect(py?.active).toBe(true);
    expect(ts?.active).toBe(false);
  });

  it('marks matchesCwd=true when project markers exist in cwd', () => {
    writeFileSync(join(process.cwd(), 'package.json'), '{}');
    const items = listExtras();
    const ts = items.find((i) => i.extra.name === 'typescript');
    expect(ts?.matchesCwd).toBe(true);
    const py = items.find((i) => i.extra.name === 'python');
    expect(py?.matchesCwd).toBe(false);
  });
});

describe('activeSystemPromptSections', () => {
  it('returns empty when no extras are active', () => {
    writeSettings({});
    expect(activeSystemPromptSections(process.cwd())).toBe('');
  });

  it('returns empty when extras are active but no project markers match', () => {
    writeSettings({ extras: ['typescript'] });
    expect(activeSystemPromptSections(process.cwd())).toBe('');
  });

  it('injects the section when active and project markers match', () => {
    writeFileSync(join(process.cwd(), 'package.json'), '{}');
    writeSettings({ extras: ['typescript'] });
    const out = activeSystemPromptSections(process.cwd());
    expect(out).toContain('TypeScript conventions');
    expect(out).toContain('tsconfig');
  });

  it('concatenates sections when multiple extras match', () => {
    writeFileSync(join(process.cwd(), 'package.json'), '{}');
    writeFileSync(join(process.cwd(), 'pyproject.toml'), '');
    writeSettings({ extras: ['typescript', 'python'] });
    const out = activeSystemPromptSections(process.cwd());
    expect(out).toContain('TypeScript conventions');
    expect(out).toContain('Python conventions');
  });

  it('skips an active extra whose project markers do not match', () => {
    writeFileSync(join(process.cwd(), 'package.json'), '{}');
    writeSettings({ extras: ['typescript', 'python'] });
    const out = activeSystemPromptSections(process.cwd());
    expect(out).toContain('TypeScript conventions');
    expect(out).not.toContain('Python conventions');
  });

  it('ignores unknown extra names in config', () => {
    writeFileSync(join(process.cwd(), 'package.json'), '{}');
    writeSettings({ extras: ['typescript', 'mystery-language'] });
    expect(activeSystemPromptSections(process.cwd())).toContain('TypeScript conventions');
  });
});
