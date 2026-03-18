import type { Tool as OllamaTool } from 'ollama';
import { z } from 'zod';

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}

/** Convert a ToolDef's Zod schema to Ollama tool format */
export function toOllamaTool(tool: ToolDef): OllamaTool {
  const shape = tool.schema.shape;
  const properties: Record<string, { type: string; description?: string; enum?: string[] }> = {};
  const required: string[] = [];

  for (const [key, zodType] of Object.entries(shape)) {
    const field = zodType as z.ZodTypeAny;
    let innerType = field;
    let isOptional = false;

    // Unwrap optional
    if (innerType instanceof z.ZodOptional) {
      isOptional = true;
      innerType = innerType.unwrap();
    }

    // Unwrap default
    if (innerType instanceof z.ZodDefault) {
      innerType = innerType.removeDefault();
    }

    const prop: { type: string; description?: string; enum?: string[] } = { type: 'string' };

    if (innerType instanceof z.ZodString) {
      prop.type = 'string';
    } else if (innerType instanceof z.ZodNumber) {
      prop.type = 'number';
    } else if (innerType instanceof z.ZodBoolean) {
      prop.type = 'boolean';
    } else if (innerType instanceof z.ZodEnum) {
      prop.type = 'string';
      prop.enum = innerType.options as string[];
    } else if (innerType instanceof z.ZodArray) {
      prop.type = 'array';
    } else {
      prop.type = 'string';
    }

    // Extract description from Zod metadata
    if (field.description) {
      prop.description = field.description;
    }

    properties[key] = prop;
    if (!isOptional) {
      required.push(key);
    }
  }

  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    },
  };
}

export function ok(output: string): ToolResult {
  return { success: true, output };
}

export function fail(error: string): ToolResult {
  return { success: false, output: '', error };
}
