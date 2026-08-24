import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerCodingTools, boundedStream } from '../src/tools/coding.js';
import { ContextManager } from '../src/context.js';

/**
 * ROUND-TRIP FIDELITY of every stage that transforms what the model sees.
 *
 * Outcome tests cannot find the failure class that matters most here. A harness
 * that silently DEGRADES the model's input — a truncated file it believes is
 * whole, a tool result attached to the wrong call, a fact dropped in compaction
 * — shows up as the model being wrong, or as a pass that happened anyway. Both
 * are invisible to a pass rate, and both are indistinguishable from model
 * capability, which is exactly the thing being claimed as out of scope.
 *
 * So these are PROPERTY tests, not outcome tests: for each stage, either the
 * model-visible representation preserves its input, or it says what it lost.
 * There is no third option, and "no third option" is the whole point.
 */
async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vcode-fidelity-'));
}
const tool = (name: string) => registerCodingTools().find((t) => t.name === name)!;

describe('stage: read_file', () => {
  it('round-trips every line of a file under the cap', async () => {
    const dir = await scratch();
    try {
      const body = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
      const p = join(dir, 'a.ts');
      await writeFile(p, body);
      const r = await tool('read_file').execute({ path: p });
      const seen = String(r.output).split('\n').map((l) => l.replace(/^\s*\d+\s\s/, ''));
      for (const original of body.split('\n')) {
        expect(seen).toContain(original);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('says what it withheld when a file exceeds the cap', async () => {
    const dir = await scratch();
    try {
      const p = join(dir, 'big.ts');
      await writeFile(p, Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n'));
      const r = await tool('read_file').execute({ path: p });
      // Silence here is the bug: a partial file the model believes is whole.
      expect(String(r.output)).toMatch(/showing lines|truncated/);
      expect(String(r.output)).toContain('offset=');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('stage: bash output capture', () => {
  it('round-trips output that fits', () => {
    const s = boundedStream();
    const text = Array.from({ length: 200 }, (_, i) => `out ${i}`).join('\n');
    s.push(text);
    expect(s.text()).toBe(text);
  });

  it('preserves both ends and states the loss when it does not fit', () => {
    const s = boundedStream(1_000, 1_000);
    s.push('HEAD-MARKER\n' + 'x'.repeat(500_000) + '\nTAIL-MARKER');
    const out = s.text();
    expect(out).toContain('HEAD-MARKER');
    expect(out).toContain('TAIL-MARKER'); // the error lives at the end
    expect(out).toMatch(/dropped from the middle/);
  });
});

describe('stage: grep', () => {
  it('round-trips the matched lines it reports', async () => {
    const dir = await scratch();
    try {
      await writeFile(join(dir, 'a.ts'), 'alpha needle one\nbeta\ngamma needle two\n');
      const r = await tool('grep').execute({ pattern: 'needle', path: dir });
      expect(String(r.output)).toContain('alpha needle one');
      expect(String(r.output)).toContain('gamma needle two');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('stage: context assembly', () => {
  function busy(c: ContextManager, n: number): void {
    for (let i = 0; i < n; i++) {
      c.addUser(`ask ${i}`);
      c.addAssistant('', [{ function: { name: 'read_file', arguments: { path: `f${i}.ts` } } } as never]);
      c.addToolResult('read_file', `contents of f${i}`);
    }
  }

  it('never hands the model a tool result without the call that produced it', () => {
    const c = new ContextManager();
    c.setSystemPrompt('qwen3');
    busy(c, 400);
    const window = c.getMessages();
    // An orphan tool message is a result attached to nothing — the model reads
    // it as an answer to whatever came before.
    expect(window[0]?.role).not.toBe('tool');
    for (let i = 0; i < window.length; i++) {
      if (window[i].role !== 'tool') continue;
      const prev = window.slice(0, i).reverse().find((m) => m.role === 'assistant');
      expect(prev, `tool result at ${i} has no preceding assistant`).toBeDefined();
    }
  });

  it('preserves message ORDER — the model must not see a stale version after a newer one', () => {
    const c = new ContextManager();
    c.setSystemPrompt('qwen3');
    busy(c, 400);
    const window = c.getMessages();
    const indices = window
      .map((m) => /ask (\d+)/.exec(m.content ?? '')?.[1])
      .filter((x): x is string => Boolean(x))
      .map(Number);
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });
});

describe('stage: tool-output pruning', () => {
  it('keeps the CALL and its arguments intact, and marks what it shortened', () => {
    const c = new ContextManager();
    c.setSystemPrompt('qwen3');
    for (let i = 0; i < 40; i++) {
      c.addUser(`step ${i}`);
      c.addAssistant('', [{ function: { name: 'grep', arguments: { pattern: `p${i}` } } } as never]);
      c.addToolResult('grep', 'match '.repeat(8_000));
    }
    expect(c.pruneToolOutputs()).toBeGreaterThan(0);
    const all = JSON.stringify(c.getAllMessages());
    // The call is what makes the transcript legible; only bulk output may go.
    expect(all).toContain('"pattern":"p0"');
    expect(all).toContain('truncated to reclaim context');
  });
});

describe('canary: a planted fact must survive the pipeline or be reported missing', () => {
  it('keeps a file the model touched visible after the window drops the message', () => {
    const c = new ContextManager();
    c.setSystemPrompt('qwen3');
    c.addUser('read the config');
    c.addAssistant('', [{ function: { name: 'read_file', arguments: { path: 'src/canary-config.ts' } } } as never]);
    c.addToolResult('read_file', 'export const TIMEOUT_MS = 4242;');
    for (let i = 0; i < 400; i++) {
      c.addUser('u'.repeat(4_000));
      c.addAssistant('a'.repeat(4_000));
    }
    c.getMessages();
    // The message naming it is long gone. If the ledger does not carry it, the
    // model has silently lost the fact that it ever touched this file.
    expect(c.getMessages().map((m) => m.content ?? '').join('\n')).toContain('src/canary-config.ts');
  });
});

describe('stage: OpenAI message translation', () => {
  it('pairs every tool result with the call that produced it, even out of order', async () => {
    const { toOpenAIMessages } = await import('../src/openai-adapter.js');
    // The parallel read-only path stores results out of call order (denied or
    // blocked calls are appended after executed ones). A positional FIFO would
    // hand the model the wrong file's contents under the right call id — and
    // the model would reason about it perfectly.
    const out = toOpenAIMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant', content: '',
        tool_calls: [
          { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
          { function: { name: 'grep', arguments: { pattern: 'x' } } },
        ],
      },
      { role: 'tool', tool_name: 'grep', content: 'GREP-RESULT' },
      { role: 'tool', tool_name: 'read_file', content: 'READ-RESULT' },
    ]);
    const assistant = out.find((m) => m.role === 'assistant');
    const idOf = (name: string) =>
      assistant.tool_calls.find((c: { function: { name: string } }) => c.function.name === name).id;
    const results = out.filter((m) => m.role === 'tool');
    const byId = Object.fromEntries(results.map((m: { tool_call_id: string; content: string }) => [m.tool_call_id, m.content]));
    expect(byId[idOf('grep')]).toBe('GREP-RESULT');
    expect(byId[idOf('read_file')]).toBe('READ-RESULT');
  });

  it('keeps two calls of the SAME tool distinguishable', async () => {
    const { toOpenAIMessages } = await import('../src/openai-adapter.js');
    const out = toOpenAIMessages([
      {
        role: 'assistant', content: '',
        tool_calls: [
          { function: { name: 'read_file', arguments: { path: 'first.ts' } } },
          { function: { name: 'read_file', arguments: { path: 'second.ts' } } },
        ],
      },
      { role: 'tool', tool_name: 'read_file', content: 'FIRST' },
      { role: 'tool', tool_name: 'read_file', content: 'SECOND' },
    ]);
    const ids = out.find((m) => m.role === 'assistant').tool_calls.map((c: { id: string }) => c.id);
    const results = out.filter((m) => m.role === 'tool');
    // Same name, two calls: results must map in call order, not collapse.
    expect(results[0].tool_call_id).toBe(ids[0]);
    expect(results[1].tool_call_id).toBe(ids[1]);
    expect(new Set(results.map((r: { tool_call_id: string }) => r.tool_call_id)).size).toBe(2);
  });

  it('never emits a result with no call to attach to', async () => {
    const { toOpenAIMessages } = await import('../src/openai-adapter.js');
    const out = toOpenAIMessages([
      { role: 'user', content: 'go' },
      { role: 'tool', tool_name: 'read_file', content: 'ORPHAN' },
    ]);
    const orphan = out.find((m) => m.role === 'tool');
    // It must still carry an id — an unattached result is a malformed request,
    // and vLLM rejects the whole turn rather than the message.
    expect(orphan.tool_call_id).toBeTruthy();
  });

  it('preserves assistant content alongside its tool calls', async () => {
    const { toOpenAIMessages } = await import('../src/openai-adapter.js');
    const out = toOpenAIMessages([
      { role: 'assistant', content: 'I will read it', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] },
    ]);
    expect(out[0].content).toBe('I will read it');
  });
});
