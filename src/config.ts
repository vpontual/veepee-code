import { resolve, join } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import type { LspServerConfig } from './lsp/config.js';

export interface Config {
  proxyUrl: string;
  dashboardUrl: string;
  model: string | null;
  lockModel: string | null;
  reviewModel: string | null;
  /** Model used for compaction summaries. Falls back to the current chat
   *  model when null. Pin a smaller/cheaper model here to keep summaries
   *  fast and stop them from blocking the main loop on a large model. */
  summarizerModel: string | null;
  autoSwitch: boolean;
  maxModelSize: number;  // max parameter count in billions (default 40)
  minModelSize: number;  // min for act mode — skip tiny models (default 12)
  apiPort: number;
  apiHost: string;
  apiToken: string | null;
  apiExecute: boolean;
  searxngUrl: string | null;
  progressBar: boolean;
  modelStick: boolean;
  sync: { url: string; user: string; pass: string; auto: boolean } | null;
  rc: { enabled: boolean } | null;
  remote: { url: string; apiKey: string; allow?: string[] } | null;
  langfuse: { secretKey: string; publicKey: string; host?: string } | null;
  shellHistoryContext: boolean;
  fleet: Array<{ name: string; url: string }>;
  hooks: HooksConfig | null;
  /** MCP servers, keyed by name. Tools register as `[mcp:<name>]` source.
   *  See src/mcp.ts for transport details. Mirrors the Claude Desktop
   *  `mcpServers` shape so configs port directly. */
  mcpServers: Record<string, McpServerConfig> | null;
  /** Subagent (Task tool) constraints. Both fields optional — defaults
   *  preserve current behavior. */
  subagent: SubagentConfig | null;
  /** Language Server Protocol integration. Keyed by language label
   *  (e.g. "typescript", "go"). When null, LSP is fully disabled and the
   *  lsp_diagnostics tool is not registered. See docs/plans/v0.4-lsp.md. */
  lsp: Record<string, LspServerConfig> | null;
}

export interface SubagentConfig {
  /** When set, the `task` tool rejects model names not in this list.
   *  Strongly recommended for fleets with pinned-per-server models so a
   *  typo can't trigger Ollama to pull/load an unintended model. Leave
   *  unset to allow any model the proxy will accept. */
  allowedModels?: string[];
  /** Override the hard-coded concurrent-subagent cap (default 4). Higher
   *  values risk vLLM slot exhaustion when subagents target the same
   *  server as the parent. */
  maxConcurrent?: number;
}

export type McpServerConfig =
  | {
      /** stdio transport — most common; spawns a child process. */
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      allow?: string[];
      disabled?: boolean;
    }
  | {
      /** SSE/HTTP transport — alternative for hosted servers. */
      url: string;
      headers?: Record<string, string>;
      allow?: string[];
      disabled?: boolean;
    };

/** Hooks configuration — see src/hooks.ts for runtime semantics. */
export interface HooksConfig {
  PreToolUse?: HookEntry[];
  PostToolUse?: HookEntry[];
  UserPromptSubmit?: HookEntry[];
  Stop?: HookEntry[];
  Notification?: HookEntry[];
}

export interface HookEntry {
  /** Optional matcher — string (literal) or regex source — applied to the
   *  primary subject of the event (tool name for PreToolUse/PostToolUse,
   *  prompt text for UserPromptSubmit, etc.). When omitted, hook runs for
   *  every event. */
  matcher?: string;
  /** Shell command to run. Receives event JSON on stdin. Stdout is shown
   *  to the user as a system message; non-zero exit aborts the action
   *  (where applicable — e.g. PreToolUse can block the tool call). */
  command: string;
  /** Optional human-readable label shown in /hooks. */
  description?: string;
  /** Override default 30s timeout in milliseconds. */
  timeoutMs?: number;
}

export interface ConfigFile {
  proxyUrl?: string;
  dashboardUrl?: string;
  model?: string | null;
  lockModel?: string | null;
  reviewModel?: string | null;
  summarizerModel?: string | null;
  autoSwitch?: boolean;
  maxModelSize?: number;
  minModelSize?: number;
  apiPort?: number;
  apiHost?: string;
  apiToken?: string | null;
  apiExecute?: boolean;
  searxngUrl?: string | null;
  progressBar?: boolean;
  modelStick?: boolean;
  sync?: { url: string; user: string; pass: string; auto: boolean } | null;
  rc?: { enabled: boolean } | null;
  remote?: { url: string; apiKey: string; allow?: string[] } | null;
  langfuse?: { secretKey: string; publicKey: string; host?: string } | null;
  shellHistoryContext?: boolean;
  fleet?: Array<{ name: string; url: string }>;
  hooks?: HooksConfig | null;
  mcpServers?: Record<string, McpServerConfig> | null;
  subagent?: SubagentConfig | null;
  lsp?: Record<string, LspServerConfig> | null;
}

const DEFAULTS: Config = {
  proxyUrl: 'http://localhost:11434',
  dashboardUrl: '',
  model: null,
  lockModel: null,
  reviewModel: null,
  summarizerModel: null,
  autoSwitch: true,
  maxModelSize: 40,
  minModelSize: 12,
  apiPort: 8484,
  apiHost: '127.0.0.1',
  apiToken: null,
  apiExecute: false,
  searxngUrl: null,
  progressBar: true,
  modelStick: false,
  sync: null,
  rc: null,
  remote: null,
  langfuse: null,
  shellHistoryContext: false,
  fleet: [],
  hooks: null,
  mcpServers: null,
  subagent: null,
  lsp: null,
};

// ─── Settings hierarchy paths ─────────────────────────────────────────
//
// Three layers, deeper wins. Mirrors Claude Code's settings layout:
//   1. Global   — ~/.veepee-code/settings.json
//   2. Project  — <cwd>/.veepee/settings.json (committed; team defaults)
//   3. Local    — <cwd>/.veepee/settings.local.json (gitignored; personal)

export type SettingsLayer = 'global' | 'project' | 'local';

export function getConfigDir(): string {
  return resolve(process.env.HOME || '~', '.veepee-code');
}

/** Canonical global settings file. New code writes here. */
export function getGlobalSettingsPath(): string {
  return resolve(getConfigDir(), 'settings.json');
}

/** Legacy filename — read for backward compat, migrated on first load. */
export function getLegacyGlobalSettingsPath(): string {
  return resolve(getConfigDir(), 'vcode.config.json');
}

export function getProjectSettingsDir(cwd: string = process.cwd()): string {
  return resolve(cwd, '.veepee');
}

export function getProjectSettingsPath(cwd: string = process.cwd()): string {
  return resolve(getProjectSettingsDir(cwd), 'settings.json');
}

export function getLocalSettingsPath(cwd: string = process.cwd()): string {
  return resolve(getProjectSettingsDir(cwd), 'settings.local.json');
}

/** Backward-compat alias. Returns the layer the global config currently
 *  lives at — `settings.json` if present, else legacy `vcode.config.json`. */
export function getConfigPath(): string {
  const newPath = getGlobalSettingsPath();
  if (existsSync(newPath)) return newPath;
  const legacy = getLegacyGlobalSettingsPath();
  if (existsSync(legacy)) return legacy;
  return newPath; // for write callers — they'll create settings.json
}

/** Returns the absolute path for a given settings layer. */
export function getSettingsPath(layer: SettingsLayer, cwd: string = process.cwd()): string {
  switch (layer) {
    case 'global': return getGlobalSettingsPath();
    case 'project': return getProjectSettingsPath(cwd);
    case 'local': return getLocalSettingsPath(cwd);
  }
}

// ─── Migrations ────────────────────────────────────────────────────────

/** Migrate legacy .env to settings.json. Returns true if migration occurred. */
export function migrateEnvToJson(): boolean {
  const configDir = getConfigDir();
  const envPath = resolve(configDir, '.env');
  const newPath = getGlobalSettingsPath();
  const legacyPath = getLegacyGlobalSettingsPath();

  if (!existsSync(envPath) || existsSync(newPath) || existsSync(legacyPath)) return false;

  const content = readFileSync(envPath, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (val) env[key] = val;
    }
  }

  const config: ConfigFile = {
    proxyUrl: env.VEEPEE_CODE_PROXY_URL || DEFAULTS.proxyUrl,
    dashboardUrl: env.VEEPEE_CODE_DASHBOARD_URL || DEFAULTS.dashboardUrl,
    model: env.VEEPEE_CODE_MODEL || null,
    autoSwitch: env.VEEPEE_CODE_AUTO_SWITCH !== 'false',
    maxModelSize: parseFloat(env.VEEPEE_CODE_MAX_MODEL_SIZE || '40'),
    minModelSize: parseFloat(env.VEEPEE_CODE_MIN_MODEL_SIZE || '12'),
    apiPort: parseInt(env.VEEPEE_CODE_API_PORT || '8484', 10),
    apiHost: env.VEEPEE_CODE_API_HOST || '127.0.0.1',
    apiToken: env.VEEPEE_CODE_API_TOKEN || null,
    apiExecute: env.VEEPEE_CODE_API_EXECUTE === '1' || env.VEEPEE_CODE_API_EXECUTE === 'true',
    searxngUrl: env.SEARXNG_URL || null,
  };

  if (env.VEEPEE_CODE_SYNC_URL && env.VEEPEE_CODE_SYNC_USER && env.VEEPEE_CODE_SYNC_PASS) {
    config.sync = {
      url: env.VEEPEE_CODE_SYNC_URL,
      user: env.VEEPEE_CODE_SYNC_USER,
      pass: env.VEEPEE_CODE_SYNC_PASS,
      auto: env.VEEPEE_CODE_SYNC_AUTO === 'true' || env.VEEPEE_CODE_SYNC_AUTO === '1',
    };
  }
  if (env.VEEPEE_CODE_RC_ENABLED === '1' || env.VEEPEE_CODE_RC_ENABLED === 'true') {
    config.rc = { enabled: true };
  }
  if (env.VEEPEE_CODE_REMOTE_URL && env.VEEPEE_CODE_REMOTE_API_KEY) {
    config.remote = { url: env.VEEPEE_CODE_REMOTE_URL, apiKey: env.VEEPEE_CODE_REMOTE_API_KEY };
  }

  writeFileSync(newPath, JSON.stringify(config, null, 2) + '\n');
  renameSync(envPath, resolve(configDir, '.env.backup'));
  return true;
}

/** Migrate legacy `vcode.config.json` to `settings.json`. Returns true if
 *  migration occurred. The legacy file is renamed to `vcode.config.json.bak`
 *  rather than deleted, so users can verify the migration succeeded.
 *
 *  Prints a one-time stderr notice on migration so users don't think their
 *  config was wiped when they see the renamed `.bak` and a new `settings.json`
 *  they don't recognize. (This was a real reported confusion — the migration
 *  used to be silent.)
 */
export function migrateLegacyConfig(): boolean {
  const newPath = getGlobalSettingsPath();
  const legacyPath = getLegacyGlobalSettingsPath();

  if (existsSync(newPath) || !existsSync(legacyPath)) return false;

  // Read, validate parse, rename.
  let content: string;
  try {
    content = readFileSync(legacyPath, 'utf-8');
    JSON.parse(content); // ensure it's valid JSON before migrating
  } catch {
    return false; // leave legacy in place if it's broken
  }

  writeFileSync(newPath, content);
  renameSync(legacyPath, legacyPath + '.bak');
  // Stderr so it doesn't pollute -p / --print stdout. Visible in interactive use.
  process.stderr.write(
    `\n  ▸ Config migrated: vcode.config.json → settings.json\n` +
    `    Your settings are intact at ${newPath}\n` +
    `    The old file was renamed to vcode.config.json.bak (safe to delete)\n\n`,
  );
  return true;
}

// ─── Layered loading ───────────────────────────────────────────────────

function readConfigFileSafe(path: string): ConfigFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    // Corrupt file — log to stderr (visible in startup banner area) but
    // don't crash. Treat as empty layer; caller continues with other layers.
    process.stderr.write(`[VEEPEE Code] warning: could not parse ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    return {};
  }
}

/** Merge config layers — later layers override earlier. Shallow replacement
 *  on top-level fields (a project-level `remote` replaces global `remote`
 *  entirely; users redeclare to merge). */
function mergeLayers(...layers: ConfigFile[]): ConfigFile {
  const out: ConfigFile = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export interface LoadedConfig extends Config {
  /** Per-layer raw contents for diagnostics (used by /settings show). */
  _layers?: { global: ConfigFile; project: ConfigFile; local: ConfigFile };
}

export function loadConfig(configPath?: string): Config {
  // If no explicit path, run migrations first
  if (configPath === undefined) {
    migrateEnvToJson();
    migrateLegacyConfig();
  }

  let merged: ConfigFile = {};

  if (configPath !== undefined) {
    // Explicit path (used by tests). Empty string = skip file loading entirely.
    if (configPath) merged = readConfigFileSafe(configPath);
  } else {
    const global = readConfigFileSafe(getGlobalSettingsPath());
    // Fall back to legacy file if migration somehow didn't run (e.g. perms)
    const globalEffective = Object.keys(global).length > 0
      ? global
      : readConfigFileSafe(getLegacyGlobalSettingsPath());
    const project = readConfigFileSafe(getProjectSettingsPath());
    const local = readConfigFileSafe(getLocalSettingsPath());
    merged = mergeLayers(globalEffective, project, local);
  }

  return {
    proxyUrl: merged.proxyUrl ?? DEFAULTS.proxyUrl,
    dashboardUrl: merged.dashboardUrl ?? DEFAULTS.dashboardUrl,
    model: merged.model ?? DEFAULTS.model,
    lockModel: merged.lockModel ?? DEFAULTS.lockModel,
    reviewModel: merged.reviewModel ?? DEFAULTS.reviewModel,
    summarizerModel: merged.summarizerModel ?? DEFAULTS.summarizerModel,
    autoSwitch: merged.autoSwitch ?? DEFAULTS.autoSwitch,
    maxModelSize: merged.maxModelSize ?? DEFAULTS.maxModelSize,
    minModelSize: merged.minModelSize ?? DEFAULTS.minModelSize,
    apiPort: merged.apiPort ?? DEFAULTS.apiPort,
    apiHost: merged.apiHost ?? DEFAULTS.apiHost,
    apiToken: merged.apiToken ?? DEFAULTS.apiToken,
    apiExecute: merged.apiExecute ?? DEFAULTS.apiExecute,
    searxngUrl: merged.searxngUrl ?? DEFAULTS.searxngUrl,
    progressBar: merged.progressBar ?? DEFAULTS.progressBar,
    modelStick: merged.modelStick ?? DEFAULTS.modelStick,
    sync: merged.sync ?? DEFAULTS.sync,
    rc: merged.rc ?? DEFAULTS.rc,
    remote: merged.remote ?? DEFAULTS.remote,
    langfuse: merged.langfuse ?? DEFAULTS.langfuse,
    shellHistoryContext: merged.shellHistoryContext ?? DEFAULTS.shellHistoryContext,
    fleet: merged.fleet ?? DEFAULTS.fleet,
    hooks: merged.hooks ?? DEFAULTS.hooks,
    mcpServers: merged.mcpServers ?? DEFAULTS.mcpServers,
    subagent: merged.subagent ?? DEFAULTS.subagent,
    lsp: merged.lsp ?? DEFAULTS.lsp,
  };
}

/** Load and return per-layer contents in addition to merged Config. Used by
 *  the /settings command to show provenance ("this value came from project"). */
export function loadConfigLayered(cwd: string = process.cwd()): LoadedConfig {
  migrateEnvToJson();
  migrateLegacyConfig();
  const global = readConfigFileSafe(getGlobalSettingsPath());
  const globalEffective = Object.keys(global).length > 0
    ? global
    : readConfigFileSafe(getLegacyGlobalSettingsPath());
  const project = readConfigFileSafe(getProjectSettingsPath(cwd));
  const local = readConfigFileSafe(getLocalSettingsPath(cwd));
  const config = loadConfig() as LoadedConfig;
  config._layers = { global: globalEffective, project, local };
  return config;
}

/** Save configuration. Defaults to the global layer (preserves existing
 *  behavior). Pass `layer` to write to project or local instead. */
export function saveConfigFile(config: ConfigFile, layer: SettingsLayer = 'global'): void {
  const path = getSettingsPath(layer);
  // For project/local, ensure parent dir exists.
  if (layer !== 'global') {
    const dir = getProjectSettingsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

/** Read raw contents of a single settings layer (does not apply defaults). */
export function readSettingsLayer(layer: SettingsLayer, cwd: string = process.cwd()): ConfigFile {
  return readConfigFileSafe(getSettingsPath(layer, cwd));
}

// ─── .gitignore helper ─────────────────────────────────────────────────

/** Ensure `.veepee/settings.local.json` is gitignored in the project. Returns
 *  true if the gitignore was modified (caller can show a confirmation). */
export function ensureLocalSettingsGitignored(cwd: string = process.cwd()): boolean {
  const gitignorePath = resolve(cwd, '.gitignore');
  const ignoreLine = '.veepee/settings.local.json';
  let content = '';
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf-8');
    if (content.split('\n').some((l) => l.trim() === ignoreLine)) return false;
  }
  // Only auto-modify if .git exists — don't pollute non-git dirs.
  if (!existsSync(resolve(cwd, '.git'))) return false;
  const newContent = content + (content.endsWith('\n') || content === '' ? '' : '\n') +
    '\n# VEEPEE Code — local-only settings (personal overrides, not committed)\n' +
    ignoreLine + '\n';
  writeFileSync(gitignorePath, newContent);
  return true;
}

/** Convenience for callers that need just the project settings dir for
 *  related artifacts (commands/, hooks/, plan.md, etc.). */
export { join as joinPath };
