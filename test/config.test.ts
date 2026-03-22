import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfigState } from '../src/config.js';

describe('loadConfig', () => {
  // Save and restore ALL env vars since loadConfig reads from dotenv
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    resetConfigState();
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
    const config = loadConfig('');

    expect(typeof config.proxyUrl).toBe('string');
    expect(config.proxyUrl).toMatch(/^https?:\/\//);
    expect(config.model === null || typeof config.model === 'string').toBe(true);
    expect(typeof config.autoSwitch).toBe('boolean');
    expect(typeof config.maxTurns).toBe('number');
    expect(typeof config.maxModelSize).toBe('number');
    expect(typeof config.minModelSize).toBe('number');
    for (const key of ['sync', 'rc', 'remote'] as const) {
      expect(config[key] === null || typeof config[key] === 'object').toBe(true);
    }
  });

  it('reads proxy URL from env', () => {
    process.env.VEEPEE_CODE_PROXY_URL = 'http://192.168.1.100:11434';
    const config = loadConfig('');
    expect(config.proxyUrl).toBe('http://192.168.1.100:11434');
  });

  it('reads model from env', () => {
    process.env.VEEPEE_CODE_MODEL = 'qwen3:8b';
    const config = loadConfig('');
    expect(config.model).toBe('qwen3:8b');
  });

  it('reads autoSwitch as false when explicitly set', () => {
    process.env.VEEPEE_CODE_AUTO_SWITCH = 'false';
    const config = loadConfig('');
    expect(config.autoSwitch).toBe(false);
  });

  it('reads numeric config values', () => {
    process.env.VEEPEE_CODE_MAX_TURNS = '100';
    process.env.VEEPEE_CODE_MAX_MODEL_SIZE = '80';
    process.env.VEEPEE_CODE_MIN_MODEL_SIZE = '3';
    const config = loadConfig('');
    expect(config.maxTurns).toBe(100);
    expect(config.maxModelSize).toBe(80);
    expect(config.minModelSize).toBe(3);
  });

  it('builds remote config when both URL and key present', () => {
    process.env.VEEPEE_CODE_REMOTE_URL = 'http://192.168.1.100:8080';
    process.env.VEEPEE_CODE_REMOTE_API_KEY = 'sk-test-key';
    const config = loadConfig('');
    expect(config.remote).toEqual({ url: 'http://192.168.1.100:8080', apiKey: 'sk-test-key' });
  });

  it('remote config requires both URL and key', () => {
    // Only URL, no key — should be null
    process.env.VEEPEE_CODE_REMOTE_URL = 'http://192.168.1.100:8080';
    delete process.env.VEEPEE_CODE_REMOTE_API_KEY;
    const config = loadConfig('');
    expect(config.remote).toBeNull();
  });

  it('builds sync config with auto flag', () => {
    process.env.VEEPEE_CODE_SYNC_URL = 'https://dav.example.com';
    process.env.VEEPEE_CODE_SYNC_USER = 'user';
    process.env.VEEPEE_CODE_SYNC_PASS = 'pass';
    process.env.VEEPEE_CODE_SYNC_AUTO = 'true';
    const config = loadConfig('');
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
    const config = loadConfig('');
    expect(config.sync!.auto).toBe(false);
  });

  it('enables RC when env var is 1', () => {
    process.env.VEEPEE_CODE_RC_ENABLED = '1';
    const config = loadConfig('');
    expect(config.rc).toEqual({ enabled: true });
  });

  it('RC is null when not enabled', () => {
    const config = loadConfig('');
    expect(config.rc).toBeNull();
  });
});
