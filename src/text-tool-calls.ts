/**
 * Recover tool calls a model wrote as TEXT instead of as structured calls.
 *
 * Small local models often do this: asked through Ollama's tools API,
 * qwen2.5-coder:7b answered a fresh install's "read note.txt" with the content
 * `{"name": "read_file", "arguments": {"path": "note.txt"}}` and no tool call,
 * so vcode printed JSON and stopped. Hermes/Qwen-style models do the same with
 * `<tool_call>…</tool_call>` tags.
 *
 * Deliberately strict. It fires only when the WHOLE answer is tool calls —
 * bare JSON, one ```json fence, or nothing but <tool_call> blocks — and only
 * for names that are registered tools. A model explaining JSON, or quoting a
 * call inside prose, stays text: executing something the model merely
 * mentioned would be far worse than not executing something it meant.
 */
import type { ToolCall } from 'ollama';

type Candidate = { name?: unknown; arguments?: unknown; parameters?: unknown };

function toCall(c: Candidate, known: (name: string) => boolean): ToolCall | null {
  if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !known(c.name)) return null;
  let args = c.arguments ?? c.parameters ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { function: { name: c.name, arguments: args as Record<string, unknown> } };
}

function parseCalls(json: string, known: (name: string) => boolean): ToolCall[] | null {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return null; }
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return null;
  const calls: ToolCall[] = [];
  for (const item of list) {
    const call = toCall(item as Candidate, known);
    if (!call) return null; // all or nothing
    calls.push(call);
  }
  return calls;
}

export function parseTextToolCalls(answer: string, known: (name: string) => boolean): ToolCall[] | null {
  const text = answer.trim();
  if (!text) return null;

  // <tool_call>{…}</tool_call> blocks, and nothing else.
  if (text.startsWith('<tool_call>')) {
    const blocks = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)];
    if (blocks.length === 0) return null;
    if (text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim() !== '') return null;
    const calls: ToolCall[] = [];
    for (const b of blocks) {
      const parsed = parseCalls(b[1], known);
      if (!parsed) return null;
      calls.push(...parsed);
    }
    return calls;
  }

  // A single ```json fence, and nothing else.
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  if (fence) return parseCalls(fence[1], known);

  // Bare JSON.
  if (text.startsWith('{') || text.startsWith('[')) return parseCalls(text, known);
  return null;
}
