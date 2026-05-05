import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRecipes, recipeByLabel, KNOWN_RECIPES, writeServerToSettings, whichBin } from '../src/lsp/install.js';

let tmp: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vcode-install-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('detectRecipes', () => {
  it('returns typescript when package.json is present', () => {
    writeFileSync(join(tmp, 'package.json'), '{}');
    const got = detectRecipes(tmp).map((r) => r.label);
    expect(got).toContain('typescript');
  });

  it('returns python when pyproject.toml is present', () => {
    writeFileSync(join(tmp, 'pyproject.toml'), '');
    const got = detectRecipes(tmp).map((r) => r.label);
    expect(got).toContain('python');
  });

  it('returns multiple recipes for polyglot projects', () => {
    writeFileSync(join(tmp, 'package.json'), '{}');
    writeFileSync(join(tmp, 'go.mod'), 'module test');
    const got = detectRecipes(tmp).map((r) => r.label).sort();
    expect(got).toEqual(['go', 'typescript']);
  });

  it('returns empty for an unrecognized project', () => {
    expect(detectRecipes(tmp)).toEqual([]);
  });
});

describe('recipeByLabel', () => {
  it('returns null for unknown label', () => {
    expect(recipeByLabel('nonexistent-lang')).toBeNull();
  });

  it('returns the typescript recipe', () => {
    const r = recipeByLabel('typescript');
    expect(r).not.toBeNull();
    expect(r?.serverConfig.command).toBe('typescript-language-server');
    expect(r?.serverConfig.filetypes).toContain('ts');
  });

  it('every known recipe has the required shape', () => {
    for (const r of KNOWN_RECIPES) {
      expect(r.label).toBeTruthy();
      expect(r.language).toBeTruthy();
      expect(r.install.command).toBeTruthy();
      expect(Array.isArray(r.install.args)).toBe(true);
      expect(r.serverConfig.command).toBeTruthy();
      expect(r.serverConfig.filetypes.length).toBeGreaterThan(0);
      expect(r.binaryProbe).toBeTruthy();
      expect(r.projectMarkers.length).toBeGreaterThan(0);
    }
  });
});

describe('writeServerToSettings', () => {
  function settingsPath() {
    return join(tmp, '.veepee-code', 'settings.json');
  }

  function readSettings(): unknown {
    const fs = require('node:fs');
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  }

  function setupSettingsDir() {
    const fs = require('node:fs');
    fs.mkdirSync(join(tmp, '.veepee-code'), { recursive: true });
  }

  it('creates settings.json when missing', () => {
    setupSettingsDir();
    const recipe = recipeByLabel('typescript')!;
    const r = writeServerToSettings(recipe.label, recipe.serverConfig);
    expect(r.changed).toBe(true);
    const s = readSettings() as { lsp: Record<string, unknown> };
    expect(s.lsp).toHaveProperty('typescript');
  });

  it('preserves existing keys when adding a new lsp entry', () => {
    setupSettingsDir();
    const fs = require('node:fs');
    fs.writeFileSync(settingsPath(), JSON.stringify({ proxyUrl: 'http://example' }));
    const recipe = recipeByLabel('typescript')!;
    writeServerToSettings(recipe.label, recipe.serverConfig);
    const s = readSettings() as { proxyUrl: string; lsp: Record<string, unknown> };
    expect(s.proxyUrl).toBe('http://example');
    expect(s.lsp).toHaveProperty('typescript');
  });

  it('refuses to overwrite an existing lsp entry', () => {
    setupSettingsDir();
    const fs = require('node:fs');
    fs.writeFileSync(settingsPath(), JSON.stringify({ lsp: { typescript: { command: 'custom-bin' } } }));
    const recipe = recipeByLabel('typescript')!;
    const r = writeServerToSettings(recipe.label, recipe.serverConfig);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain('already exists');
    const s = readSettings() as { lsp: Record<string, { command: string }> };
    expect(s.lsp.typescript.command).toBe('custom-bin');
  });

  it('reports a clear error when settings.json is malformed', () => {
    setupSettingsDir();
    const fs = require('node:fs');
    fs.writeFileSync(settingsPath(), '{ this is not json');
    const recipe = recipeByLabel('typescript')!;
    const r = writeServerToSettings(recipe.label, recipe.serverConfig);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain('not valid JSON');
  });
});

describe('whichBin', () => {
  it('returns null for a nonexistent binary', () => {
    expect(whichBin('definitely-not-a-real-binary-12345')).toBeNull();
  });

  it('finds a known PATH binary', () => {
    // `node` itself is guaranteed to be on PATH for these tests.
    expect(whichBin('node')).toBeTruthy();
  });

  it('absolute path: returns the path when the file exists, null when not', () => {
    expect(whichBin('/usr/bin/env') ?? '').toMatch(/env$/);
    expect(whichBin('/totally/fake/nope')).toBeNull();
  });
});
