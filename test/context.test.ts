import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/context.js';

describe('ContextManager', () => {
  it('starts with zero messages', () => {
    const ctx = new ContextManager('test');
    expect(ctx.messageCount()).toBe(0);
    expect(ctx.getMessages()).toEqual([]);
  });

  it('adds user and assistant messages', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');
    ctx.addUser('hello');
    ctx.addAssistant('hi there');
    expect(ctx.messageCount()).toBe(2);
  });

  it('returns token-aware window of recent messages', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');
    ctx.setContextLimit(1024); // small context to force windowing

    // Add many messages that exceed the token budget
    for (let i = 0; i < 10; i++) {
      ctx.addUser(`msg ${i} ${'x'.repeat(200)}`);
      ctx.addAssistant(`reply ${i} ${'y'.repeat(200)}`);
    }

    const messages = ctx.getMessages();
    // Should return fewer messages than the full 20
    expect(messages.length).toBeLessThan(20);
    expect(messages.length).toBeGreaterThanOrEqual(2); // minimum 2 messages
    // Most recent messages should be included
    expect(messages[messages.length - 1].content).toContain('reply 9');
  });

  it('getAllMessages returns full history', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');

    for (let i = 0; i < 10; i++) {
      ctx.addUser(`msg ${i}`);
      ctx.addAssistant(`reply ${i}`);
    }

    expect(ctx.getAllMessages().length).toBe(20);
  });

  it('system prompt includes model and date', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('qwen3.5:35b');
    const prompt = ctx.getSystemPrompt();
    expect(prompt).toContain('qwen3.5:35b');
    expect(prompt).toContain(new Date().toISOString().split('T')[0]);
  });

  it('system prompt includes knowledge state after updates', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');
    ctx.addUser('fix the auth');
    ctx.addAssistant('done');

    const prompt = ctx.getSystemPrompt();
    expect(prompt).toContain('Knowledge State');
    expect(prompt).toContain('TURN: 1');
  });

  it('compact trims messages to fit token budget', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');
    ctx.setContextLimit(2048); // small context

    // Add many messages
    for (let i = 0; i < 20; i++) {
      ctx.addUser(`msg ${i} ${'x'.repeat(100)}`);
      ctx.addAssistant(`reply ${i} ${'y'.repeat(100)}`);
    }

    expect(ctx.messageCount()).toBe(40);
    const compacted = ctx.compact();
    expect(compacted).toBe(true);
    // After compaction, only the token-aware window remains
    expect(ctx.messageCount()).toBeLessThan(40);
  });

  it('compact returns false when not needed', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');
    ctx.addUser('hello');
    ctx.addAssistant('hi');
    expect(ctx.compact()).toBe(false);
  });

  it('clear resets everything', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');
    ctx.addUser('hello');
    ctx.addAssistant('hi');
    ctx.clear();
    expect(ctx.messageCount()).toBe(0);
    expect(ctx.getKnowledgeState().getTurn()).toBe(0);
  });

  it('mode switching works', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');

    ctx.setMode('plan');
    expect(ctx.isPlanMode()).toBe(true);
    expect(ctx.getSystemPrompt()).toContain('PLANNING');

    ctx.setMode('chat');
    expect(ctx.isPlanMode()).toBe(false);
    expect(ctx.getSystemPrompt()).toContain('CHAT');

    ctx.setMode('act');
    expect(ctx.isPlanMode()).toBe(false);
  });

  it('estimates tokens based on sliding window', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');

    const baseTokens = ctx.estimateTokens();

    // Add messages
    ctx.addUser('a'.repeat(400));
    ctx.addAssistant('b'.repeat(400));

    const afterTokens = ctx.estimateTokens();
    expect(afterTokens).toBeGreaterThan(baseTokens);
  });

  it('tracks signals correctly', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');
    ctx.addUser('short');
    ctx.addUser('a longer message with more content');

    const signals = ctx.getSignals();
    expect(signals.avgUserMessageLength).toBeGreaterThan(0);
    expect(signals.fileOpsCount).toBe(0);
    expect(signals.errorCount).toBe(0);
  });

  describe('compaction summary message', () => {
    it('preserves an injected summary message at the head of the window after compact()', () => {
      const ctx = new ContextManager('test');
      ctx.setSystemPrompt('test-model');
      ctx.setContextLimit(512);

      for (let i = 0; i < 20; i++) {
        ctx.addUser(`message ${i} ${'x'.repeat(60)}`);
        ctx.addAssistant(`reply ${i} ${'y'.repeat(60)}`);
      }

      ctx.setSummaryMessage({
        role: 'user',
        content: '[Context summary from earlier turns]: implemented loop detection',
      });

      const before = ctx.getAllMessages().length;
      const compacted = ctx.compact();
      expect(compacted).toBe(true);

      const after = ctx.getAllMessages();
      expect(after.length).toBeLessThan(before);
      expect(after[0].role).toBe('user');
      expect(after[0].content).toContain('Context summary from earlier turns');
    });

    it('clear() resets the summary message', () => {
      const ctx = new ContextManager('test');
      ctx.setSystemPrompt('test-model');
      ctx.setSummaryMessage({ role: 'user', content: '[Context summary]: foo' });
      expect(ctx.getSummaryMessage()).not.toBe(null);

      ctx.clear();
      expect(ctx.getSummaryMessage()).toBe(null);
    });

    it('compact() returns false when there are not enough messages to drop', () => {
      const ctx = new ContextManager('test');
      ctx.setSystemPrompt('test-model');
      ctx.addUser('hi');
      ctx.addAssistant('hello');
      expect(ctx.compact()).toBe(false);
    });

    it('compactAsync falls back to drop-only when the proxy is unreachable', async () => {
      const ctx = new ContextManager('test');
      ctx.setSystemPrompt('test-model');
      ctx.setContextLimit(512);

      for (let i = 0; i < 20; i++) {
        ctx.addUser(`message ${i} ${'x'.repeat(60)}`);
        ctx.addAssistant(`reply ${i} ${'y'.repeat(60)}`);
      }

      const before = ctx.getAllMessages().length;
      const compacted = await ctx.compactAsync(
        'http://127.0.0.1:1',
        'fake-model',
        null,
        500,
      );
      expect(compacted).toBe(true);
      expect(ctx.getAllMessages().length).toBeLessThan(before);
    });
  });
});
