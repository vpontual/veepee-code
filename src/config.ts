import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

export interface Config {
  proxyUrl: string;
  dashboardUrl: string;
  model: string | null;
  autoSwitch: boolean;
  maxTurns: number;
  maxModelSize: number;  // max parameter count in billions (default 40)
  minModelSize: number;  // min for act mode — skip tiny models (default 6)
  searxngUrl: string | null;
  sync: { url: string; user: string; pass: string; auto: boolean } | null;
  rc: { enabled: boolean } | null;
  remote: { url: string; apiKey: string } | null;
}

let dotenvLoaded = false;

/** Reset dotenv state — used by tests to ensure clean env loading */
export function resetConfigState(): void {
  dotenvLoaded = false;
}

export function loadConfig(envPath?: string): Config {
  // Load .env file on first call. On subsequent calls (e.g. after wizard),
  // use override to pick up any changes the wizard wrote to the file.
  const override = dotenvLoaded; // override on reload, not on first load

  if (envPath !== undefined) {
    // Explicit path (or empty string to skip dotenv entirely — used by tests)
    if (envPath) loadEnv({ path: envPath, override });
  } else {
    const localEnv = resolve(process.cwd(), '.env');
    const homeEnv = resolve(process.env.HOME || '~', '.veepee-code', '.env');
    const globalEnv = resolve(process.env.HOME || '~', '.config', 'veepee-code', '.env');

    if (existsSync(localEnv)) loadEnv({ path: localEnv, override });
    else if (existsSync(homeEnv)) loadEnv({ path: homeEnv, override });
    else if (existsSync(globalEnv)) loadEnv({ path: globalEnv, override });
  }

  dotenvLoaded = true;

  const env = process.env;

  return {
    proxyUrl: env.VEEPEE_CODE_PROXY_URL || 'http://localhost:11434',
    dashboardUrl: env.VEEPEE_CODE_DASHBOARD_URL || '',
    model: env.VEEPEE_CODE_MODEL || null,
    autoSwitch: env.VEEPEE_CODE_AUTO_SWITCH !== 'false',
    maxTurns: parseInt(env.VEEPEE_CODE_MAX_TURNS || '50', 10),
    maxModelSize: parseFloat(env.VEEPEE_CODE_MAX_MODEL_SIZE || '40'),
    minModelSize: parseFloat(env.VEEPEE_CODE_MIN_MODEL_SIZE || '6'),
    searxngUrl: env.SEARXNG_URL || null,
    sync: env.VEEPEE_CODE_SYNC_URL && env.VEEPEE_CODE_SYNC_USER && env.VEEPEE_CODE_SYNC_PASS
      ? {
          url: env.VEEPEE_CODE_SYNC_URL,
          user: env.VEEPEE_CODE_SYNC_USER,
          pass: env.VEEPEE_CODE_SYNC_PASS,
          auto: env.VEEPEE_CODE_SYNC_AUTO === 'true' || env.VEEPEE_CODE_SYNC_AUTO === '1',
        }
      : null,
    rc: env.VEEPEE_CODE_RC_ENABLED === '1' || env.VEEPEE_CODE_RC_ENABLED === 'true'
      ? { enabled: true }
      : null,
    remote: env.VEEPEE_CODE_REMOTE_URL && env.VEEPEE_CODE_REMOTE_API_KEY
      ? { url: env.VEEPEE_CODE_REMOTE_URL, apiKey: env.VEEPEE_CODE_REMOTE_API_KEY }
      : null,
  };
}
