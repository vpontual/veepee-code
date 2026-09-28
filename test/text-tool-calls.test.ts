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
