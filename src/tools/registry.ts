import type { Tool as OllamaTool } from 'ollama';
import type { ToolDef, ToolResult, ToolSource } from './types.js';
import { toOllamaTool } from './types.js';

/** Unwrap ZodOptional/Default/Nullable/Effects to the base type name (e.g. 'ZodBoolean'). */
function unwrapType(field: unknown): string | undefined {
  let f = field as { _def?: { typeName?: string; innerType?: unknown; schema?: unknown } } | undefined;
  const seen = new Set<unknown>();
  while (f?._def && !seen.has(f)) {
    seen.add(f);
    const tn = f._def.typeName;
    if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault') { f = f._def.innerType as typeof f; continue; }
    if (tn === 'ZodEffects') { f = f._def.schema as typeof f; continue; }
    return tn;
  }
  return f?._def?.typeName;
}

/** Peel wrappers and return the underlying schema node (not just its name). */
function unwrapSchema(field: unknown): { _def?: Record<string, unknown>; shape?: unknown } | undefined {
  let f = field as { _def?: { typeName?: string; innerType?: unknown; schema?: unknown } } | undefined;
  const seen = new Set<unknown>();
  while (f?._def && !seen.has(f)) {
    seen.add(f);
    const tn = f._def.typeName;
    if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault') { f = f._def.innerType as typeof f; continue; }
    if (tn === 'ZodEffects') { f = f._def.schema as typeof f; continue; }
    break;
  }
  return f as ReturnType<typeof unwrapSchema>;
}

/** Coerce one scalar the model got slightly wrong, given its expected type. */
function coerceScalar(typeName: string | undefined, val: unknown): unknown {
  if (typeName === 'ZodBoolean' && typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  } else if (typeName === 'ZodNumber' && typeof val === 'string' && val.trim() !== '' && Number.isFinite(Number(val))) {
    return Number(val);
  }
  return val;
}

/**
 * Coerce the model's common type mistakes (booleans/numbers emitted as strings —
 * replace_all: "true", limit: "5") to the type the schema expects, BEFORE validation.
 * Only touches a field whose base type is boolean/number, so it never rewrites a field
 * that legitimately wants the string. Turns a hard-reject into a working tool call.
 *
 * Recurses into nested objects and array elements. It used to walk only the top
 * level, so `multi_edit` — whose booleans live at `edits[N].replace_all` — was
 * rejected outright for the one mistake this function exists to absorb. That
 * cost a whole turn, and it showed up in the harness eval as
 * "'edits.0.replace_all': Expected boolean, received string".
 */
function coerceArgs(schema: unknown, args: Record<string, unknown>): Record<string, unknown> {
  const coerced = coerceValue(schema, args, 0);
  return (coerced && typeof coerced === 'object' ? coerced : args) as Record<string, unknown>;
}

/** Depth cap: schemas this deep are not real, and it keeps a cyclic schema from hanging. */
const MAX_COERCE_DEPTH = 6;

function coerceValue(schema: unknown, val: unknown, depth: number): unknown {
  if (depth > MAX_COERCE_DEPTH) return val;
  const node = unwrapSchema(schema);
  const typeName = node?._def?.typeName as string | undefined;

  if (typeName === 'ZodObject') {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) return val;
    const shape = (node as { shape?: Record<string, unknown> }).shape;
    if (!shape) return val;
    const out: Record<string, unknown> = { ...(val as Record<string, unknown>) };
    for (const [key, child] of Object.entries(out)) {
      if (!(key in shape)) continue;
      out[key] = coerceValue(shape[key], child, depth + 1);
    }
    return out;
  }

  if (typeName === 'ZodArray') {
    if (!Array.isArray(val)) return val;
    const element = node?._def?.type;
    return val.map((item) => coerceValue(element, item, depth + 1));
  }

  return coerceScalar(typeName, val);
}

/** A validation error the model can actually act on: which field, what was wrong, what it
 *  sent, and an explicit instruction to retry — instead of a bare zod message it hallucinates
 *  a cause for and abandons the tool over. */
function describeArgError(name: string, args: Record<string, unknown>,
    error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  const parts = error.issues.map(i => {
    const key = i.path[0];
    const path = i.path.join('.') || '(root)';
    const got = key !== undefined ? args[key as string] : undefined;
    const gotDesc = got === undefined ? 'missing' : `${typeof got} ${JSON.stringify(got)?.slice(0, 40)}`;
    return `'${path}': ${i.message} (got ${gotDesc})`;
  });
  return `Invalid arguments for ${name}: ${parts.join('; ')}. Fix the argument types and call ${name} again.`;
}

/**
 * Default wall-clock budget for a single tool call.
 *
 * A hung tool blocks the agent loop indefinitely — and since runs are
 * serialized, it wedges the shared server so every later request gets 409
 * until a restart. The bash tool and hooks were the verified offenders and are
 * fixed at the source, but any tool can hang (a wedged MCP server, a socket
 * that never closes), so the loop needs its own backstop.
 *
 * Deliberately generous: this is a "something is broken" ceiling, not a
 * latency target. Tools that legitimately run longer declare `timeoutMs: null`.
 */
const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60_000;

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  /** Bulk-register many tools, skipping any whose name already exists.
   *  Returns the names that were skipped — caller can log them so users
   *  see which tools collided. Used by remote/MCP/skill loaders so a
   *  remote tool with a name matching a local tool doesn't clobber. */
  registerBatch(tools: ToolDef[]): { registered: string[]; skipped: string[] } {
    const registered: string[] = [];
    const skipped: string[] = [];
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        skipped.push(tool.name);
      } else {
        this.tools.set(tool.name, tool);
        registered.push(tool.name);
      }
    }
    return { registered, skipped };
  }

  /** Remove all tools whose source matches the given source (and optionally
   *  sourceName). Used to refresh MCP/skill tools without restarting vcode
   *  when a server reconnects or skills change on disk. */
  unregisterBySource(source: ToolSource, sourceName?: string): number {
    let removed = 0;
    for (const [name, tool] of this.tools) {
      if (tool.source !== source) continue;
      if (sourceName !== undefined && tool.sourceName !== sourceName) continue;
      this.tools.delete(name);
      removed++;
    }
    return removed;
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDef[] {
    return Array.from(this.tools.values());
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  count(): number {
    return this.tools.size;
  }

  /** Group tools by source for /tools listing. Local tools with no
   *  explicit source default to 'local'. Returns groups in display order. */
  bySource(): Array<{ source: ToolSource; sourceName?: string; tools: ToolDef[] }> {
    const groups = new Map<string, { source: ToolSource; sourceName?: string; tools: ToolDef[] }>();
    for (const tool of this.list()) {
      const source = tool.source ?? 'local';
      const key = `${source}:${tool.sourceName ?? ''}`;
      if (!groups.has(key)) {
        groups.set(key, { source, sourceName: tool.sourceName, tools: [] });
      }
      groups.get(key)!.tools.push(tool);
    }
    // Display order: local → remote → mcp → skill, then alphabetical by sourceName.
    const order: ToolSource[] = ['local', 'remote', 'mcp', 'skill'];
    return [...groups.values()].sort((a, b) => {
      const ai = order.indexOf(a.source);
      const bi = order.indexOf(b.source);
      if (ai !== bi) return ai - bi;
      return (a.sourceName ?? '').localeCompare(b.sourceName ?? '');
    });
  }

  /** Get all tools in Ollama tool-calling format */
  toOllamaTools(): OllamaTool[] {
    return this.list().map(toOllamaTool);
  }

  /** Execute a tool by name with given arguments */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, output: '', error: `Unknown tool: ${name}` };
    }

    try {
      const coerced = coerceArgs(tool.schema, args);
      const parsed = tool.schema.safeParse(coerced);
      if (!parsed.success) {
        return { success: false, output: '', error: describeArgError(name, coerced, parsed.error) };
      }

      const budget = tool.timeoutMs === undefined ? DEFAULT_TOOL_TIMEOUT_MS : tool.timeoutMs;
      const call = tool.execute(parsed.data as Record<string, unknown>);
      if (budget === null) return await call;

      // Racing does not cancel the underlying work — tools that own a child
      // process kill it themselves. What this guarantees is that the AGENT
      // stops waiting, which is what turns a hung tool from "vcode is dead"
      // into "that one call failed".
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          call,
          new Promise<ToolResult>((resolveP) => {
            timer = setTimeout(() => resolveP({
              success: false,
              output: '',
              error: `Tool ${name} exceeded its ${Math.round(budget / 1000)}s budget and was abandoned. `
                + `It may still be running in the background.`,
            }), budget);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        // Never leave an unhandled rejection behind when the race is lost.
        void Promise.resolve(call).catch(() => undefined);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Tool ${name} failed: ${msg}` };
    }
  }
}
