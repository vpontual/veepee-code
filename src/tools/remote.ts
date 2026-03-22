/**
 * Remote tool bridge — discovers and proxies tools from a remote agent API.
 *
 * On startup, fetches the tool catalog from a configured endpoint (e.g. Llama Rider)
 * and registers each remote tool as a native VEEPEE Code tool. Execution is proxied
 * via HTTP — no tool logic lives in this repo.
 */

import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';

interface RemoteToolDef {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

interface RemoteConfig {
  url: string;     // e.g. http://host:8080
  apiKey: string;
}

/**
 * Discover tools from a remote agent API and return proxy ToolDefs.
 * Skips tools that already exist locally (by name).
 */
export async function discoverRemoteTools(
  remote: RemoteConfig,
  localToolNames: Set<string>,
): Promise<ToolDef[]> {
  const tools: ToolDef[] = [];

  let remoteDefs: RemoteToolDef[];
  try {
    const res = await fetch(`${remote.url}/dashboard/api/tools`, {
      headers: { Authorization: `Bearer ${remote.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { tools: RemoteToolDef[] };
    remoteDefs = data.tools || [];
  } catch {
    return [];
  }

  for (const def of remoteDefs) {
    // Skip tools that exist locally — local version takes priority
    if (localToolNames.has(def.name)) continue;

    const schema = buildZodSchema(def.parameters);
    tools.push({
      name: def.name,
      description: `[remote] ${def.description}`,
      schema,
      execute: createRemoteExecutor(remote, def.name),
    });
  }

  return tools;
}

/** Build a Zod schema from JSON Schema-like parameters */
function buildZodSchema(
  params: RemoteToolDef['parameters'],
): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  const required = new Set(params.required || []);

  for (const [key, prop] of Object.entries(params.properties || {})) {
    let field: z.ZodTypeAny;

    switch (prop.type) {
      case 'number':
      case 'integer':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      default:
        field = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
    }

    if (prop.description) {
      field = field.describe(prop.description);
    }

    shape[key] = required.has(key) ? field : field.optional();
  }

  return z.object(shape);
}

/** Create an executor that proxies the tool call to the remote API */
function createRemoteExecutor(
  remote: RemoteConfig,
  toolName: string,
): (params: Record<string, unknown>) => Promise<ToolResult> {
  return async (params) => {
    try {
      const res = await fetch(
        `${remote.url}/dashboard/api/tools/${encodeURIComponent(toolName)}/execute`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${remote.apiKey}`,
          },
          body: JSON.stringify({ args: params }),
          signal: AbortSignal.timeout(30_000),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        return { success: false, output: '', error: `Remote tool ${toolName} failed (${res.status}): ${err}` };
      }

      const result = await res.json() as { output?: string; isError?: boolean; error?: string };
      return {
        success: !result.isError,
        output: result.output || '',
        error: result.isError ? (result.error || result.output || 'Remote execution failed') : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Remote tool ${toolName}: ${msg}` };
    }
  };
}
