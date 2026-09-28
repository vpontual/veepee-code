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
    // The turn-varying state block now rides at the tail (see
    // `volatileContextBlock`) so the cacheable prefix ends before it, so assert
    // the newest real content is present rather than that it is last.
    expect(messages.map((m) => m.content ?? '').join('\n')).toContain('reply 9');
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

  it('knowledge state reaches the model, out of the cacheable prefix', () => {
    const ctx = new ContextManager('test');
    ctx.setSystemPrompt('test-model');
    ctx.addUser('fix the auth');
    ctx.addAssistant('done');

    // It must reach the model — but NOT from inside the system prompt, whose
    // stability is what makes the KV prefix cache work. Measured: a changing
    // tail took the hit rate from 78% to 0%.
    // The static prompt DESCRIBES the knowledge state; what must not be in it
    // is the turn-varying DATA, which is what breaks the cacheable prefix.
    expect(ctx.getSystemPrompt()).not.toContain('TURN: 1');
    const seen = ctx.getMessages().map((m) => m.content ?? '').join('\n');
    expect(seen).toContain('Knowledge State');
    expect(seen).toContain('TURN: 1');
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

    ctx.setMode('chat');
    expect(ctx.getSystemPrompt()).toContain('CHAT');

    ctx.setMode('act');
    expect(ctx.getSystemPrompt()).not.toContain('CHAT mode');
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

describe('verify is a hold the model can see, not a smaller toolbox', () => {
  // Plan mode used to filter bash/edit_file/write_file/multi_edit out of the
  // tool list. The model could not see them, so it could neither use them NOR
  // say they were unavailable — asked to analyse config drift, it READ the
  // project's own pinky_drift.py and rebuilt its output with ~50 read-only calls.
  // Verify keeps every tool visible; permissions refuse with a reason.
  const cm = new ContextManager({} as never);
  cm.setVerify(true);
  const prompt = cm.getSystemPrompt();

  it('tells the model what is held and how to ask', () => {
    expect(prompt).toMatch(/Verify \(ACTIVE\)/);
    expect(prompt).toContain('request_approval');
  });

  it('tells the model not to reproduce a held command by hand', () => {
    expect(prompt).toMatch(/Never reconstruct by hand/);
  });

  it('adds nothing when verify is off', () => {
    const off = new ContextManager({} as never);
    expect(off.getSystemPrompt()).not.toMatch(/Verify \(ACTIVE\)/);
    cm.setVerify(false);
    expect(cm.getSystemPrompt()).not.toMatch(/Verify \(ACTIVE\)/);
  });
});
