import type { Tool as OllamaTool } from 'ollama';
import type { ToolDef, ToolResult, ToolSource } from './types.js';
import { toOllamaTool } from './types.js';

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
      const parsed = tool.schema.safeParse(args);
      if (!parsed.success) {
        return {
          success: false,
          output: '',
          error: `Invalid arguments for ${name}: ${parsed.error.issues.map(i => i.message).join(', ')}`,
        };
      }
      return await tool.execute(parsed.data as Record<string, unknown>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Tool ${name} failed: ${msg}` };
    }
  }
}
