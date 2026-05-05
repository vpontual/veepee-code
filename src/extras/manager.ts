/**
 * Extras manager. Adding/removing extras updates settings.json so the
 * configuration is durable across sessions and across machines (when
 * settings.json is synced).
 *
 * Per-extra side effects:
 *   - Install LSP recipes via runInstall + writeServerToSettings.
 *   - Register PostToolUse hooks under config.hooks.PostToolUse.
 *   - Append the extra name to config.extras (string[]).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recipeByLabel, runInstall, writeServerToSettings, whichBin } from '../lsp/install.js';
import { extraByName, BUILTIN_EXTRAS } from './builtins.js';
import type { Extra } from './types.js';

const HOOK_TAG = '[extra:'; // marker we embed in hook descriptions to identify extra-installed hooks for /extras remove

interface SettingsShape {
  extras?: string[];
  hooks?: { PostToolUse?: Array<{ matcher?: string; command: string; description?: string }> } & Record<string, unknown>;
  lsp?: Record<string, unknown>;
  [key: string]: unknown;
}

function settingsPath(): string {
  return resolve(process.env.HOME || '~', '.veepee-code', 'settings.json');
}

function readSettings(): SettingsShape {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf-8')) as SettingsShape; } catch { return {}; }
}

function writeSettings(s: SettingsShape): void {
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + '\n');
}

export interface AddOutcome {
  ok: boolean;
  installed: string[];     // LSP recipes that were just installed
  alreadyPresent: string[]; // LSP recipes already on PATH
  hooksAdded: number;
  message: string;
}

export function addExtra(name: string): AddOutcome {
  const extra = extraByName(name);
  if (!extra) {
    return { ok: false, installed: [], alreadyPresent: [], hooksAdded: 0, message: `No extra named '${name}'. Run /extras list for available extras.` };
  }

  const settings = readSettings();
  const installed: string[] = [];
  const alreadyPresent: string[] = [];

  // 1. Install LSP recipes
  for (const recipeLabel of extra.lspRecipes) {
    const recipe = recipeByLabel(recipeLabel);
    if (!recipe) continue;
    if (whichBin(recipe.binaryProbe)) {
      alreadyPresent.push(recipeLabel);
    } else {
      const out = runInstall(recipe);
      if (!out.ok) {
        return { ok: false, installed, alreadyPresent, hooksAdded: 0, message: `Failed to install ${recipe.language}: ${out.message}` };
      }
      installed.push(recipeLabel);
    }
    // Always merge into settings.lsp (no-op if present)
    writeServerToSettings(recipe.label, recipe.serverConfig);
  }

  // Re-read after writeServerToSettings updates the file
  const updated = readSettings();

  // 2. Register hooks under PostToolUse, tagged so we can remove them later
  const hooks = updated.hooks ?? {};
  const post = hooks.PostToolUse ?? [];
  let hooksAdded = 0;
  for (const h of extra.postEditHooks) {
    const tag = `${HOOK_TAG}${name}] ${h.description ?? ''}`.trim();
    // Skip if a hook with this exact command already exists (idempotent re-add)
    if (post.some((existing) => existing.command === h.command)) continue;
    post.push({ matcher: h.matcher, command: h.command, description: tag });
    hooksAdded++;
  }
  hooks.PostToolUse = post;
  updated.hooks = hooks;

  // 3. Track in config.extras
  const list = (updated.extras ?? []).filter((n) => n !== name);
  list.push(name);
  updated.extras = list;

  writeSettings(updated);

  return {
    ok: true,
    installed,
    alreadyPresent,
    hooksAdded,
    message: `Added '${name}' extra.`,
  };
}

export interface RemoveOutcome {
  ok: boolean;
  hooksRemoved: number;
  message: string;
}

export function removeExtra(name: string): RemoveOutcome {
  const extra = extraByName(name);
  if (!extra) return { ok: false, hooksRemoved: 0, message: `No extra named '${name}'.` };

  const settings = readSettings();
  if (!settings.extras?.includes(name)) {
    return { ok: false, hooksRemoved: 0, message: `Extra '${name}' is not currently installed.` };
  }

  // Remove hooks tagged with this extra. Leave LSP servers in place — the
  // user might want to keep using lsp_diagnostics even without the extra's
  // formatter hook. Document this in /extras list.
  const tag = `${HOOK_TAG}${name}]`;
  const post = settings.hooks?.PostToolUse ?? [];
  const before = post.length;
  const kept = post.filter((h) => !(h.description && h.description.startsWith(tag)));
  if (settings.hooks) settings.hooks.PostToolUse = kept;
  const hooksRemoved = before - kept.length;

  // Remove from config.extras
  settings.extras = (settings.extras ?? []).filter((n) => n !== name);

  writeSettings(settings);
  return { ok: true, hooksRemoved, message: `Removed '${name}' extra. LSP server entries left in settings.lsp; remove manually if desired.` };
}

/** List built-in extras with active/inactive status. */
export function listExtras(): Array<{ extra: Extra; active: boolean; matchesCwd: boolean }> {
  const settings = readSettings();
  const active = new Set(settings.extras ?? []);
  const cwd = process.cwd();
  return BUILTIN_EXTRAS.map((extra) => ({
    extra,
    active: active.has(extra.name),
    matchesCwd: extra.projectMarkers.some((m) => existsSync(resolve(cwd, m))),
  }));
}

/** Returns the system-prompt sections for every active extra whose project
 *  markers are present in cwd. Empty string when no extras apply. */
export function activeSystemPromptSections(cwd: string = process.cwd()): string {
  const settings = readSettings();
  const active = settings.extras ?? [];
  const sections: string[] = [];
  for (const name of active) {
    const extra = extraByName(name);
    if (!extra) continue;
    const matches = extra.projectMarkers.some((m) => existsSync(resolve(cwd, m)));
    if (!matches) continue;
    sections.push(extra.systemPromptSection);
  }
  return sections.length === 0 ? '' : '\n' + sections.join('\n\n') + '\n';
}
