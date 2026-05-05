/**
 * Mason-style LSP server installer. Each known language has a recipe:
 * how to install the server binary, what to write into settings.lsp.
 *
 * Recipes are intentionally hard-coded here rather than fetched from a
 * registry — small set, stable enough, and the user can override every
 * setting after install. Adding a new recipe is one entry in
 * KNOWN_RECIPES; no plugin loader needed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LspServerConfig } from './config.js';

export interface InstallRecipe {
  /** Stable label key used in settings.lsp. */
  label: string;
  /** Human-readable language name, e.g. "TypeScript". */
  language: string;
  /** Single command + args used to install. */
  install: { command: string; args: string[] };
  /** Settings written into settings.lsp[label] after install. */
  serverConfig: LspServerConfig;
  /** What we expect to find on PATH after install (or absolute path). */
  binaryProbe: string;
  /** Detection: file patterns that identify a project of this type. Used by
   *  /lsp install (no args) to suggest what to install. */
  projectMarkers: string[];
}

export const KNOWN_RECIPES: InstallRecipe[] = [
  {
    label: 'typescript',
    language: 'TypeScript / JavaScript',
    install: { command: 'npm', args: ['install', '-g', 'typescript-language-server', 'typescript'] },
    serverConfig: {
      command: 'typescript-language-server',
      args: ['--stdio'],
      filetypes: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
      rootPatterns: ['tsconfig.json', 'package.json'],
      warmOnStart: true,
    },
    binaryProbe: 'typescript-language-server',
    projectMarkers: ['tsconfig.json', 'package.json'],
  },
  {
    label: 'python',
    language: 'Python',
    install: { command: 'npm', args: ['install', '-g', 'pyright'] },
    serverConfig: {
      command: 'pyright-langserver',
      args: ['--stdio'],
      filetypes: ['py'],
      rootPatterns: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'requirements.txt'],
    },
    binaryProbe: 'pyright-langserver',
    projectMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'],
  },
  {
    label: 'go',
    language: 'Go',
    install: { command: 'go', args: ['install', 'golang.org/x/tools/gopls@latest'] },
    serverConfig: {
      command: 'gopls',
      args: [],
      filetypes: ['go'],
      rootPatterns: ['go.mod', 'go.work'],
    },
    binaryProbe: 'gopls',
    projectMarkers: ['go.mod', 'go.work'],
  },
  {
    label: 'rust',
    language: 'Rust',
    install: { command: 'rustup', args: ['component', 'add', 'rust-analyzer'] },
    serverConfig: {
      command: 'rust-analyzer',
      args: [],
      filetypes: ['rs'],
      rootPatterns: ['Cargo.toml'],
    },
    binaryProbe: 'rust-analyzer',
    projectMarkers: ['Cargo.toml'],
  },
  {
    label: 'lua',
    language: 'Lua',
    install: { command: 'pacman', args: ['-S', '--noconfirm', 'lua-language-server'] },
    serverConfig: {
      command: 'lua-language-server',
      args: [],
      filetypes: ['lua'],
      rootPatterns: ['.luarc.json', 'stylua.toml', '.git'],
    },
    binaryProbe: 'lua-language-server',
    projectMarkers: ['.luarc.json', 'stylua.toml'],
  },
];

export function recipeByLabel(label: string): InstallRecipe | null {
  return KNOWN_RECIPES.find((r) => r.label === label) ?? null;
}

/** Detect which recipes apply to the given cwd by scanning for project marker files. */
export function detectRecipes(cwd: string): InstallRecipe[] {
  return KNOWN_RECIPES.filter((r) => r.projectMarkers.some((m) => existsSync(resolve(cwd, m))));
}

export function whichBin(name: string): string | null {
  if (name.startsWith('/') || name.startsWith('./')) {
    return existsSync(name) ? name : null;
  }
  const r = spawnSync('which', [name], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export interface InstallOutcome {
  ok: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
}

/** Run the recipe's install command. Returns structured outcome — does not
 *  throw. */
export function runInstall(recipe: InstallRecipe): InstallOutcome {
  const r = spawnSync(recipe.install.command, recipe.install.args, {
    encoding: 'utf-8',
    timeout: 5 * 60_000, // 5 minutes — npm installs can be slow
  });
  if (r.error) {
    return { ok: false, message: `${recipe.install.command} failed: ${r.error.message}`, stderr: r.stderr };
  }
  if (r.status !== 0) {
    return { ok: false, message: `${recipe.install.command} exited ${r.status}`, stdout: r.stdout, stderr: r.stderr };
  }
  // Verify the binary appeared
  const found = whichBin(recipe.binaryProbe);
  if (!found) {
    return {
      ok: false,
      message: `${recipe.install.command} succeeded but '${recipe.binaryProbe}' is not on PATH`,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  }
  return { ok: true, message: `Installed ${recipe.language} server (${found})`, stdout: r.stdout };
}

/** Merge a new server entry into ~/.veepee-code/settings.json. Preserves
 *  existing keys, never clobbers an existing label. */
export function writeServerToSettings(label: string, cfg: LspServerConfig): { changed: boolean; path: string; reason?: string } {
  const path = resolve(process.env.HOME || '~', '.veepee-code', 'settings.json');
  let json: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      json = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      return { changed: false, path, reason: `existing settings.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const lsp = (json.lsp as Record<string, unknown> | null | undefined) ?? {};
  if (lsp[label]) {
    return { changed: false, path, reason: `lsp.${label} already exists in settings.json — leaving it alone` };
  }
  lsp[label] = cfg;
  json.lsp = lsp;
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  return { changed: true, path };
}
