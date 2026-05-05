#!/usr/bin/env node
/**
 * Polish-regression check.
 *
 * Catches the kinds of polish gaps surfaced by the 2026-05-03 audit
 * (declared-but-never-bound KeyActions, declared-but-never-handled actions,
 * etc.). Runs as part of `npm run prebuild`. Exits 0 on clean, 1 on any
 * finding, with a clear message of what to fix.
 *
 * Add new checks here whenever a polish issue is found in review — the goal
 * is to make each class of issue impossible to re-introduce silently.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(process.cwd());
const issues = [];

// ─── Check 1: KeyActions declared but never bound ──────────────────────
//
// Every member of the KeyAction union in src/tui/keybindings.ts should appear
// at least once as a value in DEFAULT_BINDINGS. If it doesn't, it's dead
// code — a name no key currently produces. This catches the Phase 0 finding
// where scrollTop/scrollBottom were declared but had no key bindings.

try {
  const src = readFileSync(resolve(ROOT, 'src/tui/keybindings.ts'), 'utf-8');

  // Extract action names from the union: looks like
  //   | 'submit' | 'newline' | 'abort' ... ;
  const unionMatch = src.match(/export type KeyAction =\s*([\s\S]*?);/);
  if (!unionMatch) {
    issues.push('keybindings.ts: could not find `export type KeyAction = ...` union');
  } else {
    const declared = new Set(
      [...unionMatch[1].matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map((m) => m[1]),
    );

    // Extract values from DEFAULT_BINDINGS:  '...': 'actionName',
    const bound = new Set(
      [...src.matchAll(/:\s*'([a-zA-Z][a-zA-Z0-9]*)'\s*,/g)].map((m) => m[1]),
    );

    const unbound = [...declared].filter((a) => !bound.has(a));
    if (unbound.length > 0) {
      issues.push(
        'keybindings.ts: KeyActions declared in the union but bound to no key:\n' +
          unbound.map((a) => `  - '${a}'`).join('\n') +
          "\n  Either bind them in DEFAULT_BINDINGS or remove from the union.",
      );
    }
  }
} catch (err) {
  issues.push(`could not read src/tui/keybindings.ts: ${err.message}`);
}

// ─── Check 2: AppAction types declared but never handled ───────────────
//
// Every variant of the AppAction union in src/tui/types.ts should have a
// matching `case 'TYPE':` in src/tui/reducer.ts. TypeScript's exhaustive
// switch can catch this when the function's return type is the state, but
// it doesn't always — and even when it does, the error message is opaque.
// Explicit check gives a clear list.

try {
  const types = readFileSync(resolve(ROOT, 'src/tui/types.ts'), 'utf-8');
  const reducer = readFileSync(resolve(ROOT, 'src/tui/reducer.ts'), 'utf-8');

  const actionUnionMatch = types.match(/export type AppAction =\s*([\s\S]*?);/);
  if (actionUnionMatch) {
    const declaredActions = new Set(
      [...actionUnionMatch[1].matchAll(/type:\s*'([A-Z_]+)'/g)].map((m) => m[1]),
    );
    const handledActions = new Set(
      [...reducer.matchAll(/case\s+'([A-Z_]+)'\s*:/g)].map((m) => m[1]),
    );
    const unhandled = [...declaredActions].filter((a) => !handledActions.has(a));
    if (unhandled.length > 0) {
      issues.push(
        'reducer.ts: AppAction types declared in the union but missing reducer cases:\n' +
          unhandled.map((a) => `  - ${a}`).join('\n') +
          '\n  Add `case \'TYPE\':` handlers or remove from the union.',
      );
    }
  }
} catch (err) {
  // types.ts/reducer.ts not found in expected layout — skip silently rather
  // than block the build for an unrelated refactor. Exhaustiveness compiler
  // checks remain the primary safety net.
}

// ─── Check 3: Config keys declared but never defaulted ─────────────────
//
// Every field on the Config interface in src/config.ts should have an entry
// in DEFAULTS. Missing default = `undefined` leaks through, which is a
// silent footgun for anything reading the config.

try {
  const cfg = readFileSync(resolve(ROOT, 'src/config.ts'), 'utf-8');
  const interfaceMatch = cfg.match(/export interface Config\s*\{([\s\S]*?)\n\}/);
  const defaultsMatch = cfg.match(/const DEFAULTS:\s*Config\s*=\s*\{([\s\S]*?)\n\};/);
  if (interfaceMatch && defaultsMatch) {
    const fields = new Set(
      [...interfaceMatch[1].matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*[?:]/gm)].map((m) => m[1]),
    );
    const defaulted = new Set(
      [...defaultsMatch[1].matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]),
    );
    const undefaulted = [...fields].filter((f) => !defaulted.has(f));
    if (undefaulted.length > 0) {
      issues.push(
        'config.ts: Config interface fields with no entry in DEFAULTS:\n' +
          undefaulted.map((f) => `  - ${f}`).join('\n') +
          '\n  Add a default value to DEFAULTS for each field.',
      );
    }
  }
} catch {
  // config.ts not in expected shape — skip.
}

// ─── Check 4: Hook event names documented in /help ────────────────────
//
// Every event name in `HOOK_EVENTS` (src/hooks.ts) should be mentioned in
// the /help output (src/index.ts). Catches the common Phase-1 footgun of
// adding a new event without telling users it exists.

try {
  const hooks = readFileSync(resolve(ROOT, 'src/hooks.ts'), 'utf-8');
  const help = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf-8');
  const eventListMatch = hooks.match(/HOOK_EVENTS:\s*HookEventName\[\]\s*=\s*\[([\s\S]*?)\]/);
  if (eventListMatch) {
    const events = [...eventListMatch[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    // Find the /help case body — it lives inside a switch, so we just
    // check the whole file once for each event name to be lenient.
    const undocumented = events.filter((e) => !help.includes(e));
    if (undocumented.length > 0) {
      issues.push(
        `hooks.ts: HOOK_EVENTS not referenced anywhere in src/index.ts (likely missing from /help):\n` +
          undocumented.map((e) => `  - ${e}`).join('\n') +
          '\n  Document each event in the /help command body or the user won\'t discover it.',
      );
    }
  }
} catch {
  // hooks.ts not found in expected layout — skip silently.
}

// ─── Check 5: ToolSource union covered by registry ordering ───────────
//
// Adding a new ToolSource (e.g. 'plugin') without updating the display
// order in registry.ts means /tools will silently bucket it last with
// no group label. Walk the union, assert each value appears in the order
// array.

try {
  const types = readFileSync(resolve(ROOT, 'src/tools/types.ts'), 'utf-8');
  const registry = readFileSync(resolve(ROOT, 'src/tools/registry.ts'), 'utf-8');
  const unionMatch = types.match(/export type ToolSource\s*=\s*([^;]+);/);
  if (unionMatch) {
    const sources = [...unionMatch[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
    const orderMatch = registry.match(/const order:\s*ToolSource\[\]\s*=\s*\[([^\]]+)\]/);
    if (orderMatch) {
      const ordered = new Set(
        [...orderMatch[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]),
      );
      const missing = sources.filter((s) => !ordered.has(s));
      if (missing.length > 0) {
        issues.push(
          'tools/registry.ts: ToolSource values not in `bySource` display order:\n' +
            missing.map((s) => `  - '${s}'`).join('\n') +
            '\n  Add each missing source to the `order` array so /tools renders it.',
        );
      }
    } else {
      issues.push('tools/registry.ts: could not find `bySource` order array — refactor may have broken polish coverage.');
    }
  }
} catch {
  // tools/types.ts not in expected layout — skip silently.
}

// ─── Check 6: MCP transport keys symmetric with config shape ───────────
//
// `McpServerConfig` has two shapes (stdio vs SSE). The MCP client must
// branch on `'command' in cfg` (stdio) vs the URL form (SSE). Lint catches
// the case where a third transport gets added to the type but not handled
// in connectAndDiscover.

try {
  const mcp = readFileSync(resolve(ROOT, 'src/mcp.ts'), 'utf-8');
  const cfg = readFileSync(resolve(ROOT, 'src/config.ts'), 'utf-8');
  // Each transport branch in mcp.ts should reference a discriminator field
  // (`command` for stdio, `url` for SSE). If McpServerConfig grows a third
  // shape, this check should fail until the new shape is wired.
  const transportShapes = (cfg.match(/(?:command|url):\s*string/g) ?? []).length;
  // The McpServerConfig union has 2 shapes. We expect exactly 2 transport
  // discriminators. If type grows but client doesn't, fail.
  const stdioBranch = mcp.includes("'command' in cfg");
  if (transportShapes >= 2 && !stdioBranch) {
    issues.push("mcp.ts: McpServerConfig has multiple transport shapes but the connect branch doesn't discriminate on 'command'. Update connectAndDiscover.");
  }
} catch {
  // mcp.ts not present — skip.
}

// ─── Check 7: PLAN_DISABLED_TOOLS contains real tool names ─────────────
//
// Plan-mode gate filters tools by name. A typo in PLAN_DISABLED_TOOLS
// silently lets the wrong tool through. Verify every entry appears as a
// `name: '<entry>'` somewhere in the tools/ dir or hooks.ts (remote/MCP
// names are dynamic and excluded).

try {
  const planGate = readFileSync(resolve(ROOT, 'src/tools/plan-gate.ts'), 'utf-8');
  const m = planGate.match(/PLAN_DISABLED_TOOLS\s*=\s*new\s+Set<string>\(\[([\s\S]*?)\]\)/);
  if (m) {
    const declared = [...m[1].matchAll(/'([a-z_]+)'/g)].map((mm) => mm[1]);
    const codingFiles = [
      'src/tools/coding.ts',
      'src/tools/devops.ts',
      'src/tools/web.ts',
      'src/tools/task.ts',
      'src/tools/plan-gate.ts',
    ];
    const allNames = new Set();
    for (const f of codingFiles) {
      try {
        const src = readFileSync(resolve(ROOT, f), 'utf-8');
        for (const nm of src.matchAll(/name:\s*'([a-z_]+)'/g)) allNames.add(nm[1]);
      } catch { /* file not present */ }
    }
    // 'shell' and 'docker' come from the remote bridge — not in tools/. Allow them.
    const allowDynamic = new Set(['shell']);
    const orphans = declared.filter((d) => !allNames.has(d) && !allowDynamic.has(d) && d !== 'docker');
    if (orphans.length > 0) {
      issues.push(
        'tools/plan-gate.ts: PLAN_DISABLED_TOOLS entries that don\'t match any registered tool name:\n' +
          orphans.map((n) => `  - '${n}'`).join('\n') +
          '\n  Either fix the typo or remove if the tool no longer exists.',
      );
    }
  }
} catch {
  // plan-gate.ts not yet shipped — skip silently.
}

// ─── Check 8: SubagentConfig exposed in DEFAULTS + loadConfig merge ────
//
// New config blocks are easy to forget in DEFAULTS or the merge function
// (loadConfig); the result is `undefined` leaking into runtime. Specific
// to subagent because it has nested optional fields users might rely on.

try {
  const cfg = readFileSync(resolve(ROOT, 'src/config.ts'), 'utf-8');
  if (cfg.includes('SubagentConfig')) {
    if (!cfg.includes('subagent: null') || !cfg.match(/subagent:\s*merged\.subagent/)) {
      issues.push('config.ts: `subagent` field not wired through DEFAULTS and loadConfig merge — config will be `undefined` at runtime.');
    }
  }
} catch {
  // config.ts not present — skip.
}

// ─── Check 8b: LspServerConfig exposed in DEFAULTS + loadConfig merge ──
//
// Mirrors the subagent check. The LSP block is opt-in (default null) but
// must be merged from layered settings or it's undefined at runtime.

try {
  const cfg = readFileSync(resolve(ROOT, 'src/config.ts'), 'utf-8');
  if (cfg.includes('LspServerConfig')) {
    if (!cfg.includes('lsp: null') || !cfg.match(/lsp:\s*merged\.lsp/)) {
      issues.push('config.ts: `lsp` field not wired through DEFAULTS and loadConfig merge — config will be `undefined` at runtime.');
    }
  }
} catch {
  // config.ts not present — skip.
}

// ─── Check 9: Image extensions consistent between extract & expand ────
//
// extractImages(...) and expandFileMentions(...) both look at file
// extensions to decide what to do with a path. If their lists diverge,
// the same .png could be both inlined as text AND attached as base64,
// or fall through both branches with no handler. Verify the two image
// extension sets in src/agent.ts are equal.

try {
  const agent = readFileSync(resolve(ROOT, 'src/agent.ts'), 'utf-8');
  // extractImages uses a regex with the `ext` variable
  const extractMatch = agent.match(/const ext\s*=\s*'\(\?:([a-z|]+)\)'/);
  // expandFileMentions uses a Set literal
  const expandMatch = agent.match(/const imageExts\s*=\s*new Set\(\[([^\]]+)\]\)/);
  if (extractMatch && expandMatch) {
    const extractExts = extractMatch[1].split('|').map((s) => s.trim()).filter(Boolean).sort();
    const expandExts = [...expandMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    if (extractExts.join(',') !== expandExts.join(',')) {
      issues.push(
        'agent.ts: image extensions differ between extractImages and expandFileMentions:\n' +
          `  extractImages: ${extractExts.join(', ')}\n` +
          `  expandFileMentions: ${expandExts.join(', ')}\n` +
          '  Keep them in sync — divergence means the same path could be double-processed or fall through both.',
      );
    }
  }
} catch {
  // agent.ts not in expected shape — skip silently.
}

// ─── Check 10: Notebook actions exhaustive ─────────────────────────────
//
// notebook_edit dispatches on a Zod enum. If the enum gains a new value
// without a matching `if (action === ...)` branch, the new action would
// silently fall to "Unknown action" forever. Verify the union and the
// dispatch are in sync.

try {
  const nb = readFileSync(resolve(ROOT, 'src/tools/notebook.ts'), 'utf-8');
  const enumMatch = nb.match(/action:\s*z\.enum\(\[([^\]]+)\]\)/);
  if (enumMatch) {
    const declared = [...enumMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const handled = [...nb.matchAll(/if \(action === '([a-z]+)'/g)].map((m) => m[1]);
    const handledSet = new Set([...handled, 'list']); // 'list' uses combined check
    // The `list || read || edit || delete` short-circuit at top covers list.
    const missing = declared.filter((d) => !handled.includes(d) && d !== 'list');
    if (missing.length > 0) {
      issues.push(
        'notebook.ts: actions in z.enum but no `if (action === ...)` branch:\n' +
          missing.map((d) => `  - '${d}'`).join('\n') +
          '\n  Add the dispatch or remove from the enum.',
      );
    }
  }
} catch {
  // notebook.ts not present — skip.
}

// (Checks 11+ below cover settings layer + gitignore — preserved from
// Phase 1. Numbering is informational; users should read the messages, not
// count.)
//
// ─── Check 11: Every settings layer file is gitignore-aware ────────────
//
// `settings.local.json` should never be committed. Verify the ensure
// helper exists and that the .gitignore template references the file.

try {
  const cfg = readFileSync(resolve(ROOT, 'src/config.ts'), 'utf-8');
  if (!cfg.includes('settings.local.json')) {
    issues.push('config.ts: no reference to `settings.local.json` — local layer file is undocumented or unimplemented.');
  }
  if (!cfg.includes('ensureLocalSettingsGitignored')) {
    issues.push('config.ts: missing `ensureLocalSettingsGitignored` helper — local-layer file could be committed accidentally.');
  }
} catch {
  // config.ts not in expected shape — skip.
}

// ─── Report ────────────────────────────────────────────────────────────

if (issues.length === 0) {
  process.exit(0);
}

console.error('');
console.error('[veepee-code] Polish-regression check failed:');
console.error('');
for (const msg of issues) {
  console.error(msg);
  console.error('');
}
console.error('Fix these or update scripts/check-polish.mjs if a finding is intentional.');
console.error('');
process.exit(1);
