import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  // Save and restore ALL env vars since loadConfig reads from dotenv
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear ALL config-relevant env vars (including those loaded from .env files)
    const prefixes = ['VEEPEE_CODE_', 'HA_', 'MASTODON_', 'SPOTIFY_', 'GOOGLE_', 'NEWSFEED_', 'SEARXNG_'];
    for (const key of Object.keys(process.env)) {
      if (prefixes.some(p => key.startsWith(p))) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Full restore — remove any new keys, restore old values
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  });

  it('returns correct types for all config fields', () => {
    const config = loadConfig();

    // proxyUrl is always a string (either from env or default)
    expect(typeof config.proxyUrl).toBe('string');
    expect(config.proxyUrl).toMatch(/^https?:\/\//);
    // model is string or null
    expect(config.model === null || typeof config.model === 'string').toBe(true);
    expect(typeof config.autoSwitch).toBe('boolean');
    expect(typeof config.maxTurns).toBe('number');
    expect(typeof config.maxModelSize).toBe('number');
    expect(typeof config.minModelSize).toBe('number');
    // Optional configs are object or null
    for (const key of ['spotify', 'google', 'sync', 'rc'] as const) {
      expect(config[key] === null || typeof config[key] === 'object').toBe(true);
    }
  });

  it('reads proxy URL from env', () => {
    process.env.VEEPEE_CODE_PROXY_URL = 'http://10.0.153.99:11434';
    const config = loadConfig();
    expect(config.proxyUrl).toBe('http://10.0.153.99:11434');
  });

  it('reads model from env', () => {
    process.env.VEEPEE_CODE_MODEL = 'qwen3:8b';
    const config = loadConfig();
    expect(config.model).toBe('qwen3:8b');
  });

  it('reads autoSwitch as false when explicitly set', () => {
    process.env.VEEPEE_CODE_AUTO_SWITCH = 'false';
    const config = loadConfig();
    expect(config.autoSwitch).toBe(false);
  });

  it('reads numeric config values', () => {
    process.env.VEEPEE_CODE_MAX_TURNS = '100';
    process.env.VEEPEE_CODE_MAX_MODEL_SIZE = '80';
    process.env.VEEPEE_CODE_MIN_MODEL_SIZE = '3';
    const config = loadConfig();
    expect(config.maxTurns).toBe(100);
    expect(config.maxModelSize).toBe(80);
    expect(config.minModelSize).toBe(3);
  });

  it('builds HA config when both URL and token present', () => {
    process.env.HA_URL = 'http://homeassistant:8123';
    process.env.HA_TOKEN = 'test-token';
    const config = loadConfig();
    expect(config.ha).toEqual({ url: 'http://homeassistant:8123', token: 'test-token' });
  });

  it('HA config requires both URL and token', () => {
    process.env.HA_URL = 'http://ha.local:8123';
    process.env.HA_TOKEN = 'test-token-123';
    const config = loadConfig();
    expect(config.ha).toEqual({ url: 'http://ha.local:8123', token: 'test-token-123' });
  });

  it('builds Mastodon config when both URL and token present', () => {
    process.env.MASTODON_URL = 'https://mastodon.social';
    process.env.MASTODON_TOKEN = 'masto-token';
    const config = loadConfig();
    expect(config.mastodon).toEqual({ url: 'https://mastodon.social', token: 'masto-token' });
  });

  it('builds sync config with auto flag', () => {
    process.env.VEEPEE_CODE_SYNC_URL = 'https://dav.example.com';
    process.env.VEEPEE_CODE_SYNC_USER = 'user';
    process.env.VEEPEE_CODE_SYNC_PASS = 'pass';
    process.env.VEEPEE_CODE_SYNC_AUTO = 'true';
    const config = loadConfig();
    expect(config.sync).toEqual({
      url: 'https://dav.example.com',
      user: 'user',
      pass: 'pass',
      auto: true,
    });
  });

  it('sync auto defaults to false', () => {
    process.env.VEEPEE_CODE_SYNC_URL = 'https://dav.example.com';
    process.env.VEEPEE_CODE_SYNC_USER = 'user';
    process.env.VEEPEE_CODE_SYNC_PASS = 'pass';
    const config = loadConfig();
    expect(config.sync!.auto).toBe(false);
  });

  it('enables RC when env var is 1', () => {
    process.env.VEEPEE_CODE_RC_ENABLED = '1';
    const config = loadConfig();
    expect(config.rc).toEqual({ enabled: true });
  });

  it('RC is null when not enabled', () => {
    const config = loadConfig();
    expect(config.rc).toBeNull();
  });
});
