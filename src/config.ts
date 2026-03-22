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
  ha: { url: string; token: string } | null;
  mastodon: { url: string; token: string } | null;
  spotify: { clientId: string; clientSecret: string; refreshToken: string } | null;
  google: { clientId: string; clientSecret: string; refreshToken: string } | null;
  newsfeedUrl: string | null;
  searxngUrl: string | null;
  sync: { url: string; user: string; pass: string; auto: boolean } | null;
  rc: { enabled: boolean } | null;
}

export function loadConfig(): Config {
  // Load .env from project root, then from ~/.veepee-code/.env
  const localEnv = resolve(process.cwd(), '.env');
  const homeEnv = resolve(process.env.HOME || '~', '.veepee-code', '.env');
  const globalEnv = resolve(process.env.HOME || '~', '.config', 'veepee-code', '.env');

  if (existsSync(localEnv)) loadEnv({ path: localEnv, override: true });
  else if (existsSync(homeEnv)) loadEnv({ path: homeEnv, override: true });
  else if (existsSync(globalEnv)) loadEnv({ path: globalEnv, override: true });
  else loadEnv({ override: true });

  const env = process.env;

  return {
    proxyUrl: env.VEEPEE_CODE_PROXY_URL || 'http://localhost:11434',
    dashboardUrl: env.VEEPEE_CODE_DASHBOARD_URL || '',
    model: env.VEEPEE_CODE_MODEL || null,
    autoSwitch: env.VEEPEE_CODE_AUTO_SWITCH !== 'false',
    maxTurns: parseInt(env.VEEPEE_CODE_MAX_TURNS || '50', 10),
    maxModelSize: parseFloat(env.VEEPEE_CODE_MAX_MODEL_SIZE || '40'),
    minModelSize: parseFloat(env.VEEPEE_CODE_MIN_MODEL_SIZE || '6'),
    ha: env.HA_URL && env.HA_TOKEN
      ? { url: env.HA_URL, token: env.HA_TOKEN } : null,
    mastodon: env.MASTODON_URL && env.MASTODON_TOKEN
      ? { url: env.MASTODON_URL, token: env.MASTODON_TOKEN } : null,
    spotify: env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET && env.SPOTIFY_REFRESH_TOKEN
      ? { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET, refreshToken: env.SPOTIFY_REFRESH_TOKEN } : null,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: env.GOOGLE_REFRESH_TOKEN } : null,
    newsfeedUrl: env.NEWSFEED_URL || null,
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
  };
}
