/**
 * currentPromptTokens: the last measurement PLUS what was added since (2026-10-01).
 *
 * The measured figure is what the previous request cost; tool results appended
 * after it were invisible to compaction and the output budget, and the next
 * request overflowed the window (vLLM HTTP 400, the run ended).
 */
import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/context.js';

function ctx(): ContextManager {
  const c = new ContextManager();
  c.setContextLimit(131072);
  return c;
}

describe('currentPromptTokens', () => {
  it('equals the measurement when nothing was added since', () => {
    const c = ctx();
    c.addUser('fix the bug');
    c.recordPromptTokens(60_000);
    expect(c.currentPromptTokens()).toBe(60_000);
    expect(c.estimateTokens()).toBe(60_000);
  });

  it('counts a tool result appended after the measurement', () => {
    const c = ctx();
    c.addUser('fix the bug');
    c.recordPromptTokens(90_000);
    c.addAssistant('running the tests');
    c.addToolResult('bash', 'FAIL '.repeat(30_000)); // ~150 KB of test log
    expect(c.currentPromptTokens()).toBeGreaterThan(90_000 + 25_000);
  });

  it('makes compaction fire for a measurement under 75% plus a big new result', () => {
    const c = ctx();
    c.addUser('fix the bug');
    c.recordPromptTokens(90_000); // 69% of the window: below the trigger on its own
    expect(c.needsCompaction()).toBe(false);
    c.addToolResult('bash', 'FAIL '.repeat(30_000));
    expect(c.needsCompaction()).toBe(true);
  });

  it('falls back to the projection before any measurement', () => {
    const c = ctx();
    c.addUser('hi');
    expect(c.currentPromptTokens()).toBe(c.projectedTokens());
  });
});
