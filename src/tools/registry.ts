import type { Tool as OllamaTool } from 'ollama';
import type { ToolDef, ToolResult } from './types.js';
import { toOllamaTool } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
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
