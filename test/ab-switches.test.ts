import { describe, it, expect, afterEach } from 'vitest';
import { findBlockAnchorMatch } from '../src/tools/coding.js';
import { retryDecision } from '../src/retry.js';
import { ContextManager } from '../src/context.js';

/**
 * Comparing eval scores across commits is not a measurement — the harness
 * changes underneath the number, so a difference cannot be attributed. The only
 * honest A/B is the SAME BUILD run twice with one mechanism switched off, which
 * is what these exist for.
 */
const KEYS = ['VCODE_NO_BLOCK_ANCHOR', 'VCODE_NO_PRUNE', 'VCODE_NO_RETRY'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

const FILE = [
  'function f() {',
  '  const total = 1;',
  '  return total;',
  '}',
].join('\n');
// Same shape, one middle line slightly wrong — the case this strategy exists for.
const NEEDLE = [
  'function f() {',
  '  const total = 1;',
  '  return totals;',
  '}',
].join('\n');

describe('same-build A/B switches', () => {
  it('block-anchor recovery can be disabled', () => {
    expect(findBlockAnchorMatch(FILE, NEEDLE)).not.toBeNull();
    process.env.VCODE_NO_BLOCK_ANCHOR = '1';
    expect(findBlockAnchorMatch(FILE, NEEDLE)).toBeNull();
  });

  it('retry can be disabled', () => {
    expect(retryDecision(new Error('HTTP 503'), 1).retry).toBe(true);
    process.env.VCODE_NO_RETRY = '1';
    expect(retryDecision(new Error('HTTP 503'), 1).retry).toBe(false);
  });

  it('pruning can be disabled', () => {
    const c = new ContextManager();
    c.setSystemPrompt('qwen3');
    for (let i = 0; i < 30; i++) {
      c.addUser(`step ${i}`);
      c.addToolResult('grep', 'match '.repeat(8_000));
    }
    process.env.VCODE_NO_PRUNE = '1';
    expect(c.pruneToolOutputs()).toBe(0);
    delete process.env.VCODE_NO_PRUNE;
    expect(c.pruneToolOutputs()).toBeGreaterThan(0);
  });
});
