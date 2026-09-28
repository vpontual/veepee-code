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

/**
 * Holds back streamed text while it could still be a tool call written as
 * text, so a recovered call never flashes on screen as raw JSON first.
 *
 * Only an answer that STARTS like a call is held — `{`, `[`, `<tool_call>`,
 * or a fence whose first line is ``` or ```json followed by `{`/`[`. Anything
 * else is released the moment that is clear, so ordinary answers, including
 * ones that open with a ```ts block, stream exactly as before. What is held is
 * either dropped (it was a call) or released at the end of the turn.
 */
export class TextToolCallGate {
  private held = '';
  private passing: boolean;

  constructor(private readonly enabled: boolean) {
    this.passing = !enabled;
  }

  /** Text to show now for this chunk ('' while holding). */
  push(text: string): string {
    if (this.passing) return text;
    this.held += text;
    if (this.couldBeCall(this.held.trimStart())) return '';
    this.passing = true;
    const out = this.held;
    this.held = '';
    return out;
  }

  /** The stream was reset (a reasoning trace reclassified): the answer
   *  starts now, so judge it afresh. */
  reset(): void {
    this.held = '';
    this.passing = !this.enabled;
  }

  /** End of turn: whatever is still held, for the caller to show or drop. */
  end(): string {
    const out = this.held;
    this.held = '';
    return out;
  }

  private couldBeCall(t: string): boolean {
    if (t === '') return true; // leading whitespace: nothing to decide yet
    if (t.startsWith('{') || t.startsWith('[')) return true;
    if (t.startsWith('<tool_call>') || '<tool_call>'.startsWith(t)) return true;
    if ('```'.startsWith(t)) return true;
    if (!t.startsWith('```')) return false;
    const nl = t.indexOf('\n');
    if (nl < 0) return /^```(json)?$/i.test(t) || /^```j(s(on?)?)?$/i.test(t);
    if (!/^```(json)?\s*$/i.test(t.slice(0, nl))) return false;
    const body = t.slice(nl + 1).trimStart();
    return body === '' || body.startsWith('{') || body.startsWith('[');
  }
}
