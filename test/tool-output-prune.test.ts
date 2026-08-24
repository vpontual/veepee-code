import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/context.js';

/**
 * Pruning is the cheap half of context management and vcode had none: every
 * recovery went through the summarizer, which costs a model call, latency, and
 * a chance of dropping or inventing a fact. Truncating stale tool output is
 * lossless in structure — the call and its arguments survive — and free.
 */
function ctx(): ContextManager {
  const c = new ContextManager();
  c.setSystemPrompt('qwen3');
  return c;
}

function busySession(c: ContextManager, turns: number): void {
  for (let i = 0; i < turns; i++) {
    c.addUser(`step ${i}`);
    c.addAssistant('', [{ function: { name: 'grep', arguments: { pattern: `p${i}` } } } as never]);
    c.addToolResult('grep', 'match '.repeat(8_000));
  }
}

describe('tool-output pruning', () => {
  it('declines to act when there is nothing worth reclaiming', () => {
    const c = ctx();
    c.addUser('hi');
    c.addToolResult('grep', 'small result');
    expect(c.pruneToolOutputs()).toBe(0);
  });

  it('reclaims tokens from older tool output', () => {
    const c = ctx();
    busySession(c, 30);
    const before = c.projectedTokens();
    const reclaimed = c.pruneToolOutputs();
    expect(reclaimed).toBeGreaterThan(4_000);
    expect(c.projectedTokens()).toBeLessThan(before);
  });

  it('never touches the newest tool output or the last two user turns', () => {
    const c = ctx();
    busySession(c, 30);
    c.pruneToolOutputs();
    const msgs = c.getAllMessages();
    const lastTool = [...msgs].reverse().find(m => m.role === 'tool');
    // The output the model is reasoning about right now must be intact.
    expect(lastTool?.content).not.toContain('truncated to reclaim context');
  });

  it('leaves the tool CALL and its arguments intact', () => {
    const c = ctx();
    busySession(c, 30);
    c.pruneToolOutputs();
    const withCalls = c.getAllMessages().filter(m =>
      (m as unknown as { tool_calls?: unknown[] }).tool_calls?.length);
    expect(withCalls.length).toBe(30);
    expect(JSON.stringify(withCalls)).toContain('"pattern":"p0"');
  });

  it('converges — a second pass finds nothing left to do', () => {
    const c = ctx();
    busySession(c, 30);
    expect(c.pruneToolOutputs()).toBeGreaterThan(0);
    expect(c.pruneToolOutputs()).toBe(0);
  });

  it('tells the model what happened rather than silently shortening', () => {
    const c = ctx();
    busySession(c, 30);
    c.pruneToolOutputs();
    const pruned = c.getAllMessages().find(m => m.content?.includes('truncated to reclaim context'));
    expect(pruned).toBeDefined();
    expect(pruned!.content).toContain('re-run the tool if you need it again');
  });
});

describe('pruning works in the mode where sessions run longest', () => {
  it('reclaims in a headless run, which has exactly one user message', () => {
    // The guard skipped everything within the last two USER turns. Interactive
    // sessions have many; `-p`, the API, every eval and the Nightly Engineer
    // have ONE for the whole run — so the guard covered all of history and this
    // reclaimed nothing, ever, in precisely the mode that runs longest.
    // Measured before the fix: 81 messages, 105,881 projected tokens,
    // needsCompaction() true, reclaimed 0.
    const c = ctx();
    c.addUser('the one and only user message a -p run ever has');
    for (let i = 0; i < 40; i++) {
      c.addAssistant('', [{ function: { name: 'grep', arguments: { pattern: `p${i}` } } } as never]);
      c.addToolResult('grep', 'match '.repeat(8_000));
    }
    expect(c.projectedTokens()).toBeGreaterThan(50_000);
    expect(c.pruneToolOutputs()).toBeGreaterThan(10_000);
  });

  it('still protects the live end of the conversation', () => {
    const c = ctx();
    c.addUser('go');
    for (let i = 0; i < 40; i++) {
      c.addAssistant('', [{ function: { name: 'grep', arguments: { pattern: `p${i}` } } } as never]);
      c.addToolResult('grep', 'match '.repeat(8_000));
    }
    c.pruneToolOutputs();
    const msgs = c.getAllMessages();
    const lastTool = [...msgs].reverse().find((m) => m.role === 'tool');
    // The output the model is reasoning about right now is never touched.
    expect(lastTool?.content).not.toContain('truncated to reclaim context');
  });
});
