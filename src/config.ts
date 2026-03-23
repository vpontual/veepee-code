import { resolve } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';

export interface Config {
  proxyUrl: string;
  dashboardUrl: string;
  model: string | null;
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
  remote: { url: string; apiKey: string } | null;
}

export interface ConfigFile {
  proxyUrl?: string;
  dashboardUrl?: string;
  model?: string | null;
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
  remote?: { url: string; apiKey: string } | null;
}

const DEFAULTS: Config = {
  proxyUrl: 'http://localhost:11434',
  dashboardUrl: '',
  model: null,
  autoSwitch: true,
  maxModelSize: 40,
  minModelSize: 12,
  apiPort: 8484,
  apiHost: '0.0.0.0',
  apiToken: null,
  apiExecute: false,
  searxngUrl: null,
  progressBar: true,
  modelStick: false,
  sync: null,
  rc: null,
  remote: null,
};

export function getConfigDir(): string {
  return resolve(process.env.HOME || '~', '.veepee-code');
}

export function getConfigPath(): string {
  return resolve(getConfigDir(), 'vcode.config.json');
}

/** Migrate legacy .env to vcode.config.json. Returns true if migration occurred. */
export function migrateEnvToJson(): boolean {
  const configDir = getConfigDir();
  const envPath = resolve(configDir, '.env');
  const jsonPath = getConfigPath();

  if (!existsSync(envPath) || existsSync(jsonPath)) return false;

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

  writeFileSync(jsonPath, JSON.stringify(config, null, 2) + '\n');
  renameSync(envPath, resolve(configDir, '.env.backup'));
  return true;
}

export function loadConfig(configPath?: string): Config {
  // If no explicit path, try migration first
  if (configPath === undefined) {
    migrateEnvToJson();
  }

  let file: ConfigFile = {};

  if (configPath !== undefined) {
    // Explicit path (empty string = skip file loading, used by tests)
    if (configPath && existsSync(configPath)) {
      file = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } else {
    const jsonPath = getConfigPath();
    if (existsSync(jsonPath)) {
      file = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    }
  }

  return {
    proxyUrl: file.proxyUrl ?? DEFAULTS.proxyUrl,
    dashboardUrl: file.dashboardUrl ?? DEFAULTS.dashboardUrl,
    model: file.model ?? DEFAULTS.model,
    autoSwitch: file.autoSwitch ?? DEFAULTS.autoSwitch,
    maxModelSize: file.maxModelSize ?? DEFAULTS.maxModelSize,
    minModelSize: file.minModelSize ?? DEFAULTS.minModelSize,
    apiPort: file.apiPort ?? DEFAULTS.apiPort,
    apiHost: file.apiHost ?? DEFAULTS.apiHost,
    apiToken: file.apiToken ?? DEFAULTS.apiToken,
    apiExecute: file.apiExecute ?? DEFAULTS.apiExecute,
    searxngUrl: file.searxngUrl ?? DEFAULTS.searxngUrl,
    progressBar: file.progressBar ?? DEFAULTS.progressBar,
    modelStick: file.modelStick ?? DEFAULTS.modelStick,
    sync: file.sync ?? DEFAULTS.sync,
    rc: file.rc ?? DEFAULTS.rc,
    remote: file.remote ?? DEFAULTS.remote,
  };
}

export function saveConfigFile(config: ConfigFile): void {
  const jsonPath = getConfigPath();
  writeFileSync(jsonPath, JSON.stringify(config, null, 2) + '\n');
}
