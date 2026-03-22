import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `veepee-config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>): string {
    const path = resolve(tmpDir, 'vcode.config.json');
    writeFileSync(path, JSON.stringify(config));
    return path;
  }

  it('returns correct types for all config fields', () => {
    const config = loadConfig('');

    expect(typeof config.proxyUrl).toBe('string');
    expect(config.proxyUrl).toMatch(/^https?:\/\//);
    expect(config.model === null || typeof config.model === 'string').toBe(true);
    expect(typeof config.autoSwitch).toBe('boolean');
    expect(typeof config.maxModelSize).toBe('number');
    expect(typeof config.minModelSize).toBe('number');
    expect(typeof config.apiPort).toBe('number');
    expect(typeof config.apiHost).toBe('string');
    expect(typeof config.apiExecute).toBe('boolean');
    for (const key of ['sync', 'rc', 'remote'] as const) {
      expect(config[key] === null || typeof config[key] === 'object').toBe(true);
    }
  });

  it('reads proxy URL from config file', () => {
    const path = writeConfig({ proxyUrl: 'http://192.168.1.100:11434' });
    const config = loadConfig(path);
    expect(config.proxyUrl).toBe('http://192.168.1.100:11434');
  });

  it('reads model from config file', () => {
    const path = writeConfig({ model: 'qwen3:8b' });
    const config = loadConfig(path);
    expect(config.model).toBe('qwen3:8b');
  });

  it('reads autoSwitch as false when explicitly set', () => {
    const path = writeConfig({ autoSwitch: false });
    const config = loadConfig(path);
    expect(config.autoSwitch).toBe(false);
  });

  it('reads numeric config values', () => {
    const path = writeConfig({ maxModelSize: 80, minModelSize: 3 });
    const config = loadConfig(path);
    expect(config.maxModelSize).toBe(80);
    expect(config.minModelSize).toBe(3);
  });

  it('reads API config values', () => {
    const path = writeConfig({ apiPort: 9090, apiHost: '0.0.0.0', apiToken: 'secret', apiExecute: true });
    const config = loadConfig(path);
    expect(config.apiPort).toBe(9090);
    expect(config.apiHost).toBe('0.0.0.0');
    expect(config.apiToken).toBe('secret');
    expect(config.apiExecute).toBe(true);
  });

  it('builds remote config when both URL and key present', () => {
    const path = writeConfig({ remote: { url: 'http://192.168.1.100:8080', apiKey: 'sk-test-key' } });
    const config = loadConfig(path);
    expect(config.remote).toEqual({ url: 'http://192.168.1.100:8080', apiKey: 'sk-test-key' });
  });

  it('remote config is null by default', () => {
    const config = loadConfig('');
    expect(config.remote).toBeNull();
  });

  it('builds sync config', () => {
    const path = writeConfig({
      sync: { url: 'https://dav.example.com', user: 'user', pass: 'pass', auto: true },
    });
    const config = loadConfig(path);
    expect(config.sync).toEqual({
      url: 'https://dav.example.com',
      user: 'user',
      pass: 'pass',
      auto: true,
    });
  });

  it('sync defaults to null', () => {
    const config = loadConfig('');
    expect(config.sync).toBeNull();
  });

  it('reads RC config', () => {
    const path = writeConfig({ rc: { enabled: true } });
    const config = loadConfig(path);
    expect(config.rc).toEqual({ enabled: true });
  });

  it('RC is null when not set', () => {
    const config = loadConfig('');
    expect(config.rc).toBeNull();
  });

  it('uses defaults for missing fields', () => {
    const path = writeConfig({});
    const config = loadConfig(path);
    expect(config.proxyUrl).toBe('http://localhost:11434');
    expect(config.dashboardUrl).toBe('');
    expect(config.model).toBeNull();
    expect(config.autoSwitch).toBe(true);
    expect(config.maxModelSize).toBe(40);
    expect(config.minModelSize).toBe(12);
    expect(config.apiPort).toBe(8484);
    expect(config.apiHost).toBe('127.0.0.1');
    expect(config.apiToken).toBeNull();
    expect(config.apiExecute).toBe(false);
    expect(config.searxngUrl).toBeNull();
  });
});
