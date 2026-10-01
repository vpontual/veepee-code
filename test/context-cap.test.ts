/**
 * VCODE_CONTEXT_LIMIT: a per-run cap on the compaction window (2026-10-01).
 * Unset must change nothing — interactive vcode keeps its 131072 window.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { applyContextCap, contextCapFromEnv, MIN_CONTEXT_CAP, ContextManager } from '../src/context.js';

describe('contextCapFromEnv', () => {
  it('is null when unset, empty or not a plain integer', () => {
    expect(contextCapFromEnv({})).toBeNull();
    expect(contextCapFromEnv({ VCODE_CONTEXT_LIMIT: '' })).toBeNull();
    expect(contextCapFromEnv({ VCODE_CONTEXT_LIMIT: '48k' })).toBeNull();
    expect(contextCapFromEnv({ VCODE_CONTEXT_LIMIT: '-5' })).toBeNull();
  });

  it('ignores values below the floor instead of crippling the run', () => {
    expect(contextCapFromEnv({ VCODE_CONTEXT_LIMIT: String(MIN_CONTEXT_CAP - 1) })).toBeNull();
    expect(contextCapFromEnv({ VCODE_CONTEXT_LIMIT: String(MIN_CONTEXT_CAP) })).toBe(MIN_CONTEXT_CAP);
  });
});

describe('applyContextCap', () => {
  it('leaves the window alone when no cap is set', () => {
    expect(applyContextCap(131072, {})).toBe(131072);
  });
  it('lowers a larger window to the cap', () => {
    expect(applyContextCap(131072, { VCODE_CONTEXT_LIMIT: '49152' })).toBe(49152);
  });
  it('never raises a smaller model window', () => {
    expect(applyContextCap(32768, { VCODE_CONTEXT_LIMIT: '49152' })).toBe(32768);
  });
});

describe('ContextManager honours the cap', () => {
  const saved = process.env.VCODE_CONTEXT_LIMIT;
  afterEach(() => {
    if (saved === undefined) delete process.env.VCODE_CONTEXT_LIMIT;
    else process.env.VCODE_CONTEXT_LIMIT = saved;
  });

  it('defaults to 131072 when unset', () => {
    delete process.env.VCODE_CONTEXT_LIMIT;
    expect(new ContextManager().getContextLimit()).toBe(131072);
  });

  it('caps the default and every later setContextLimit', () => {
    process.env.VCODE_CONTEXT_LIMIT = '49152';
    const cm = new ContextManager();
    expect(cm.getContextLimit()).toBe(49152);
    cm.setContextLimit(262144);
    expect(cm.getContextLimit()).toBe(49152);
    cm.setContextLimit(32768);
    expect(cm.getContextLimit()).toBe(32768);
  });
});
