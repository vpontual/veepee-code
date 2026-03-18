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
}

export function loadConfig(): Config {
  // Load .env from project root, then from ~/.veepee-code/.env
  const localEnv = resolve(process.cwd(), '.env');
  const homeEnv = resolve(process.env.HOME || '~', '.veepee-code', '.env');
  const globalEnv = resolve(process.env.HOME || '~', '.config', 'veepee-code', '.env');

  if (existsSync(localEnv)) loadEnv({ path: localEnv });
  else if (existsSync(homeEnv)) loadEnv({ path: homeEnv });
  else if (existsSync(globalEnv)) loadEnv({ path: globalEnv });
  else loadEnv();

  const env = process.env;

  return {
    proxyUrl: env.VEEPEE_CODE_PROXY_URL || 'http://10.0.153.99:11434',
    dashboardUrl: env.VEEPEE_CODE_DASHBOARD_URL || 'http://10.0.153.99:3334',
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
  };
}
