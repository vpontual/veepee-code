import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/context.js';

/**
 * The sliding window was the REAL context ceiling, and nobody was looking at it.
 *
 * `getMessages()` capped the window at a flat 50% of the limit, estimated at 3
 * chars/token from `content` ALONE, while `needsCompaction()` waited for 75% of
 * the limit in REAL tokens. On a 131k-token config that is ~65k estimated
 * against ~98k real: compaction was structurally unreachable, and what actually
 * happened on a long session was the oldest messages falling off the back every
 * turn — with no summary, no knowledge-state update and no file-ledger merge.
 * Silent, and indistinguishable from working.
 */
function ctx(): ContextManager {
  const c = new ContextManager();
  c.setSystemPrompt('qwen3');
  return c;
}

describe('context window accounting', () => {
  it('counts tool-call arguments, not just content', () => {
    const a = ctx();
    const b = ctx();
    const bigCode = 'x'.repeat(50_000);

    a.addUser('write the file');
    a.addAssistant('', [{ function: { name: 'write_file', arguments: { path: 'a.ts', content: bigCode } } } as never]);

    b.addUser('write the file');
    b.addAssistant('');

    // Pre-fix both scored ~10 tokens for the assistant turn: a 50 KB payload
    // was invisible to the window, which is how a write-heavy session blew
    // straight past the limit with the estimator reporting it was fine.
    expect(a.projectedTokens()).toBeGreaterThan(b.projectedTokens() + 10_000);
  });

  it('flags a truncating window as needing compaction', () => {
    const c = ctx();
    expect(c.needsCompaction()).toBe(false);
    // Enough traffic to overflow any sane budget.
    for (let i = 0; i < 400; i++) {
      c.addUser('u'.repeat(4_000));
      c.addAssistant('a'.repeat(4_000));
    }
    c.getMessages(); // the window is computed here, and drops what will not fit
    expect(c.wasWindowTruncated()).toBe(true);
    expect(c.needsCompaction()).toBe(true);
  });

  it('folds files named by dropped messages into the compacted ledger', () => {
    const c = ctx();
    c.addUser('read it');
    c.addAssistant('', [{ function: { name: 'read_file', arguments: { path: 'src/early.ts' } } } as never]);
    for (let i = 0; i < 400; i++) {
      c.addUser('u'.repeat(4_000));
      c.addAssistant('a'.repeat(4_000));
    }
    c.getMessages();
    // The message naming early.ts is long gone from the window; the ledger is
    // the only thing that can still tell the model it was touched.
    expect(c.getSystemPrompt()).toContain('src/early.ts');
  });

  it('projects from current content while estimateTokens reports the last real cost', () => {
    const c = ctx();
    c.addUser('hi');
    c.recordPromptTokens(99_999);
    // `compactWithRetry` compared this stale figure against the limit on every
    // pass — nothing in compaction updates it — so it called dropAggressive()
    // three times and printed the same "projected N" each time.
    expect(c.estimateTokens()).toBe(99_999);
    expect(c.projectedTokens()).not.toBe(99_999);
    expect(c.projectedTokens()).toBeLessThan(50_000);
  });
});
