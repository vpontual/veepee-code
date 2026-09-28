import { describe, it, expect } from 'vitest';
import { isTransportFailure } from '../src/retry.js';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('isTransportFailure', () => {
  it('is true for unreachable servers and dropped connections', () => {
    expect(isTransportFailure(new Error('connect ECONNREFUSED 127.0.0.1:9'))).toBe(true);
    expect(isTransportFailure(Object.assign(new Error('terminated'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(isTransportFailure(new Error('Did not receive done or success response in stream.'))).toBe(true);
    expect(isTransportFailure(new Error('HTTP 503 Service Unavailable'))).toBe(true);
  });

  it('is false for errors another model would hit too', () => {
    expect(isTransportFailure(new Error('HTTP 400: maximum context length is 131072'))).toBe(false);
    expect(isTransportFailure(new Error('Invalid arguments for read_file'))).toBe(false);
  });
});

describe('fallbackModels config', () => {
  const write = (o: unknown) => { const p = join(mkdtempSync(join(tmpdir(), 'vcode-fb-')), 's.json'); writeFileSync(p, JSON.stringify(o)); return p; };
  it('defaults to none and keeps only model names', () => {
    expect(loadConfig(write({})).fallbackModels).toEqual([]);
    expect(loadConfig(write({ fallbackModels: ['gemma4:26b-a4b', '', 3, 'qwen3:8b'] })).fallbackModels).toEqual(['gemma4:26b-a4b', 'qwen3:8b']);
  });
});
