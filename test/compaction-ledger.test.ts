import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/context.js';
import type { Message } from 'ollama';

function makeMessageWithToolCall(toolName: string, path: string): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{
      function: { name: toolName, arguments: { path } },
    }],
  } as unknown as Message;
}

function makeAssistantWithFileEdits(files: Array<{ name: string; tool: string }>): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: files.map(f => ({
      function: { name: f.tool, arguments: { path: f.name } },
    })),
  } as unknown as Message;
}

describe('compaction file ledger', () => {
  it('compact() merges read/modified files from dropped messages into the ledger', () => {
    const ctx = new ContextManager('test-1');
    ctx.setSystemPrompt('test');
    ctx.setContextLimit(800); // tiny so window is small and compaction drops a lot
    // Add many messages to force the dynamic window to leave a big drop set
    for (let i = 0; i < 30; i++) {
      ctx.addUser('user message ' + 'u'.repeat(400));
      ctx.addAssistant('assistant reply ' + 'x'.repeat(400));
    }
    // Insert tool-call messages with file paths in early history (gets dropped)
    const msgs = ctx.getAllMessages();
    msgs[1] = makeMessageWithToolCall('read_file', 'src/foo.ts');
    msgs[3] = makeMessageWithToolCall('write_file', 'src/bar.ts');
    msgs[5] = makeAssistantWithFileEdits([
      { name: 'src/baz.ts', tool: 'edit_file' },
      { name: 'README.md', tool: 'read_file' },
    ]);
    ctx.replaceMessages(msgs);

    const compacted = ctx.compact();
    expect(compacted).toBe(true);

    const ledger = ctx.getCompactedFileLedger();
    expect(ledger.modified).toContain('src/bar.ts');
    expect(ledger.modified).toContain('src/baz.ts');
    expect(ledger.read).toContain('src/foo.ts');
    expect(ledger.read).toContain('README.md');
  });

  it('modified takes precedence over read when a file appears as both', () => {
    const ctx = new ContextManager('test-2');
    ctx.setSystemPrompt('test');
    ctx.setContextLimit(800);
    for (let i = 0; i < 30; i++) {
      ctx.addUser('user ' + 'u'.repeat(400));
      ctx.addAssistant('reply ' + 'x'.repeat(400));
    }
    const msgs = ctx.getAllMessages();
    msgs[1] = makeMessageWithToolCall('read_file', 'src/promoted.ts');
    msgs[3] = makeMessageWithToolCall('write_file', 'src/promoted.ts');
    ctx.replaceMessages(msgs);
    ctx.compact();
    const ledger = ctx.getCompactedFileLedger();
    expect(ledger.modified).toContain('src/promoted.ts');
    expect(ledger.read).not.toContain('src/promoted.ts');
  });

  it('the ledger surfaces in the system prompt', () => {
    const ctx = new ContextManager('test-3');
    ctx.setSystemPrompt('test');
    ctx.setCompactedFileLedger(['src/a.ts', 'src/b.ts'], ['src/c.ts']);
    const sp = ctx.getSystemPrompt();
    expect(sp).toContain('Files touched in earlier turns');
    expect(sp).toContain('src/a.ts');
    expect(sp).toContain('src/b.ts');
    expect(sp).toContain('src/c.ts');
  });

  it('the ledger is empty when nothing has been compacted (no system prompt section)', () => {
    const ctx = new ContextManager('test-4');
    ctx.setSystemPrompt('test');
    const sp = ctx.getSystemPrompt();
    expect(sp).not.toContain('Files touched in earlier turns');
  });

  it('replaceMessages clears the ledger (rewind invalidates the abandoned branch ledger)', () => {
    const ctx = new ContextManager('test-5');
    ctx.setSystemPrompt('test');
    ctx.setCompactedFileLedger(['src/old.ts'], ['src/old-write.ts']);
    expect(ctx.getCompactedFileLedger().read).toEqual(['src/old.ts']);
    ctx.replaceMessages([{ role: 'user', content: 'fresh start' }]);
    expect(ctx.getCompactedFileLedger().read).toEqual([]);
    expect(ctx.getCompactedFileLedger().modified).toEqual([]);
  });

  it('the ledger accumulates across multiple compactions', () => {
    const ctx = new ContextManager('test-6');
    ctx.setSystemPrompt('test');
    ctx.setContextLimit(800);
    for (let i = 0; i < 30; i++) {
      ctx.addUser('u' + 'u'.repeat(400));
      ctx.addAssistant('a ' + 'x'.repeat(400));
    }
    const msgs1 = ctx.getAllMessages();
    msgs1[1] = makeMessageWithToolCall('read_file', 'src/round1.ts');
    ctx.replaceMessages(msgs1);
    ctx.setCompactedFileLedger([], []); // explicit reset
    ctx.compact();
    expect(ctx.getCompactedFileLedger().read).toContain('src/round1.ts');

    // Add more messages, compact again
    for (let i = 0; i < 30; i++) {
      ctx.addUser('u2' + 'u'.repeat(400));
      ctx.addAssistant('a2 ' + 'x'.repeat(400));
    }
    const msgs2 = ctx.getAllMessages();
    msgs2[2] = makeMessageWithToolCall('write_file', 'src/round2.ts');
    ctx.replaceMessages(msgs2);
    // Re-set ledger with round1 data (replaceMessages cleared it)
    ctx.setCompactedFileLedger(['src/round1.ts'], []);
    ctx.compact();
    const finalLedger = ctx.getCompactedFileLedger();
    expect(finalLedger.read).toContain('src/round1.ts');
    expect(finalLedger.modified).toContain('src/round2.ts');
  });

  it('the ledger caps at 200 entries with FIFO eviction', () => {
    const ctx = new ContextManager('test-7');
    ctx.setSystemPrompt('test');
    const reads = Array.from({ length: 250 }, (_, i) => `f${i}.ts`);
    ctx.setCompactedFileLedger(reads, []);
    const ledger = ctx.getCompactedFileLedger();
    expect(ledger.read).toHaveLength(200);
    // Oldest (f0..f49) were evicted; newest (f50..f249) remain
    expect(ledger.read[0]).toBe('f50.ts');
    expect(ledger.read[ledger.read.length - 1]).toBe('f249.ts');
  });
});

describe('compactWithRetry', () => {
  it('reports zero retries when the first compaction already fits', async () => {
    const ctx = new ContextManager('test-r1');
    ctx.setSystemPrompt('test');
    ctx.setContextLimit(8000);
    for (let i = 0; i < 8; i++) {
      ctx.addUser('u' + i);
      ctx.addAssistant('a' + i);
    }
    const retries: Array<{ attempt: number; projected: number; limit: number }> = [];
    // Use a non-real host — compactAsync's summarizer will fail and fall
    // back to drop-only behavior. That's fine for testing the retry path.
    await ctx.compactWithRetry('http://127.0.0.1:1', 'fake-model', null, {
      onRetry: (attempt, projected, limit) => retries.push({ attempt, projected, limit }),
    });
    // Small fake context — first pass should fit, no retries
    expect(retries).toHaveLength(0);
  });

  it('triggers retries when projected tokens still exceed 85% of the limit', async () => {
    const ctx = new ContextManager('test-r2');
    // Pad system prompt with a huge block so projected always exceeds 85%
    // until aggressive drops kick in.
    ctx.setSystemPrompt('test');
    ctx.setContextLimit(2000);
    // Build many large messages
    for (let i = 0; i < 30; i++) {
      ctx.addUser('long user message ' + 'x'.repeat(300));
      ctx.addAssistant('long assistant reply ' + 'y'.repeat(300));
    }
    const retries: Array<{ attempt: number; projected: number; limit: number }> = [];
    await ctx.compactWithRetry('http://127.0.0.1:1', 'fake-model', null, {
      onRetry: (attempt, projected, limit) => retries.push({ attempt, projected, limit }),
      maxAttempts: 3,
    });
    // At least one retry should have been needed for this oversize state
    expect(retries.length).toBeGreaterThan(0);
    // After retries, the context should have shrunk substantially
    expect(ctx.getAllMessages().length).toBeLessThan(60);
  });

  it('caps retries at maxAttempts and returns true regardless', async () => {
    const ctx = new ContextManager('test-r3');
    ctx.setSystemPrompt('test');
    ctx.setContextLimit(500); // tiny — overflow guaranteed
    for (let i = 0; i < 30; i++) {
      ctx.addUser('user ' + 'x'.repeat(300));
      ctx.addAssistant('asst ' + 'y'.repeat(300));
    }
    const retries: Array<{ attempt: number; projected: number; limit: number }> = [];
    const result = await ctx.compactWithRetry('http://127.0.0.1:1', 'fake-model', null, {
      onRetry: (attempt, projected, limit) => retries.push({ attempt, projected, limit }),
      maxAttempts: 3,
    });
    expect(result).toBe(true);
    expect(retries.length).toBeLessThanOrEqual(3);
  });
});
