import { describe, it, expect } from 'vitest';
import { parseTextToolCalls } from '../src/text-tool-calls.js';

const known = (n: string) => ['read_file', 'list_files', 'bash'].includes(n);

describe('parseTextToolCalls', () => {
  it('reads the bare JSON qwen2.5-coder:7b produced on a fresh Ollama install', () => {
    expect(parseTextToolCalls('{"name": "read_file", "arguments": {"path": "note.txt"}}', known))
      .toEqual([{ function: { name: 'read_file', arguments: { path: 'note.txt' } } }]);
  });

  it('reads <tool_call> blocks, a json fence, arrays, and string arguments', () => {
    expect(parseTextToolCalls('<tool_call>\n{"name":"read_file","arguments":{"path":"a"}}\n</tool_call>\n<tool_call>{"name":"list_files","arguments":{}}</tool_call>', known))
      .toHaveLength(2);
    expect(parseTextToolCalls('```json\n{"name":"bash","arguments":{"command":"ls"}}\n```', known))
      .toEqual([{ function: { name: 'bash', arguments: { command: 'ls' } } }]);
    expect(parseTextToolCalls('[{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}]', known))
      .toEqual([{ function: { name: 'read_file', arguments: { path: 'a' } } }]);
  });

  it('leaves prose alone, even prose containing a call', () => {
    expect(parseTextToolCalls('I would call {"name":"bash","arguments":{"command":"rm -rf /"}} here.', known)).toBeNull();
    expect(parseTextToolCalls('Here is the call:\n```json\n{"name":"bash","arguments":{}}\n```', known)).toBeNull();
    expect(parseTextToolCalls('<tool_call>{"name":"bash","arguments":{}}</tool_call> and then some text', known)).toBeNull();
  });

  it('refuses unknown tools, and all of a batch if any call is bad', () => {
    expect(parseTextToolCalls('{"name":"format_disk","arguments":{}}', known)).toBeNull();
    expect(parseTextToolCalls('[{"name":"read_file","arguments":{"path":"a"}},{"name":"nope","arguments":{}}]', known)).toBeNull();
  });

  it('refuses ordinary JSON answers and malformed input', () => {
    expect(parseTextToolCalls('{"status":"ok","count":3}', known)).toBeNull();
    expect(parseTextToolCalls('{"name":"read_file","arguments":[1,2]}', known)).toBeNull();
    expect(parseTextToolCalls('{"name":"read_file", "arguments":', known)).toBeNull();
    expect(parseTextToolCalls('', known)).toBeNull();
  });
});

import { TextToolCallGate } from '../src/text-tool-calls.js';

/** Feed chunks; return what was shown during the stream and what was held at the end. */
function run(chunks: string[], enabled = true) {
  const gate = new TextToolCallGate(enabled);
  const shown = chunks.map(c => gate.push(c)).join('');
  return { shown, held: gate.end() };
}

describe('TextToolCallGate', () => {
  it('holds a bare JSON call so it never reaches the screen', () => {
    expect(run(['{"name": "read_', 'file", "arguments": {"path": "a"}}'])).toEqual({ shown: '', held: '{"name": "read_file", "arguments": {"path": "a"}}' });
  });

  it('holds <tool_call> and ```json calls, even split mid-token', () => {
    expect(run(['<tool', '_call>{"name":"x"}</tool_call>']).shown).toBe('');
    expect(run(['``', '`js', 'on\n', '{"name":"x"}\n```']).shown).toBe('');
  });

  it('streams ordinary prose at once', () => {
    expect(run(['The secret ', 'word is PELICAN.'])).toEqual({ shown: 'The secret word is PELICAN.', held: '' });
  });

  it('releases a ```ts block as soon as the fence line shows it is code', () => {
    const gate = new TextToolCallGate(true);
    expect(gate.push('```')).toBe('');
    expect(gate.push('ts\nconst x = 1;\n')).toBe('```ts\nconst x = 1;\n');
    expect(gate.push('```')).toBe('```');
  });

  it('releases a plain fence whose body is not JSON', () => {
    expect(run(['```\n', 'npm test\n```']).shown).toBe('```\nnpm test\n```');
  });

  it('holds leading whitespace until there is something to judge', () => {
    const gate = new TextToolCallGate(true);
    expect(gate.push('\n\n')).toBe('');
    expect(gate.push('Hello')).toBe('\n\nHello');
  });

  it('judges afresh after a reset (reasoning reclassified)', () => {
    const gate = new TextToolCallGate(true);
    expect(gate.push('Let me think')).toBe('Let me think');
    gate.reset();
    expect(gate.push('{"name":"x"}')).toBe('');
  });

  it('passes everything through when no tools were offered', () => {
    expect(run(['{"a":1}'], false)).toEqual({ shown: '{"a":1}', held: '' });
  });
});
