/**
 * Minimal MCP (Model Context Protocol) client.
 *
 * Spawns configured MCP servers as child processes (stdio transport) or
 * connects via SSE (HTTP), runs the JSON-RPC 2.0 handshake, lists their
 * tools, and registers each as a `ToolDef` whose `execute` proxies back to
 * the server. Tool names are namespaced as `<server>__<tool>` to avoid
 * collisions across multiple servers.
 *
 * The implementation is intentionally hand-rolled rather than using the
 * official `@modelcontextprotocol/sdk` package — vcode only needs five
 * methods (initialize, initialized, tools/list, tools/call, ping) and the
 * SDK pulls in a sizeable graph for capabilities we don't use yet
 * (resources, prompts, sampling). When we need those, we re-evaluate.
 *
 * MCP spec: https://spec.modelcontextprotocol.io/specification/
 */

import { spawn, type ChildProcess } from 'child_process';
import { z } from 'zod';
import type { ToolDef, ToolResult } from './tools/types.js';
import type { McpServerConfig } from './config.js';

const PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = { name: 'veepee-code', version: '0.3.0' };
const DEFAULT_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

// ─── JSON-RPC types ────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

interface McpToolCallResult {
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string } }
  >;
  isError?: boolean;
}

// ─── Transport interface ───────────────────────────────────────────────

interface McpTransport {
  send(msg: JsonRpcRequest | JsonRpcNotification): Promise<void>;
  onMessage(handler: (msg: JsonRpcResponse | JsonRpcNotification) => void): void;
  close(): Promise<void>;
}

// ─── Stdio transport ───────────────────────────────────────────────────

class StdioTransport implements McpTransport {
  private proc: ChildProcess;
  private buffer = '';
  private handler: ((msg: JsonRpcResponse | JsonRpcNotification) => void) | null = null;

  constructor(serverName: string, command: string, args: string[] = [], env?: Record<string, string>, cwd?: string) {
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(env || {}) },
      cwd,
    });

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error(`MCP server '${serverName}' failed to spawn (no stdio)`);
    }

    // Stderr goes to vcode's stderr so users see server errors live.
    this.proc.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(`[mcp:${serverName}] ${d.toString()}`);
    });

    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      // Newline-delimited JSON — one message per line.
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          this.handler?.(msg);
        } catch {
          process.stderr.write(`[mcp:${serverName}] non-JSON output: ${line.slice(0, 200)}\n`);
        }
      }
    });

    this.proc.on('error', (err) => {
      process.stderr.write(`[mcp:${serverName}] process error: ${err.message}\n`);
    });
  }

  async send(msg: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error('MCP server stdin closed');
    }
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  onMessage(handler: (msg: JsonRpcResponse | JsonRpcNotification) => void): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    return new Promise((resolveP) => {
      if (this.proc.exitCode !== null) {
        resolveP();
        return;
      }
      const timer = setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolveP();
      }, 2000);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolveP();
      });
      try {
        this.proc.stdin?.end();
      } catch { /* already closed */ }
      this.proc.kill('SIGTERM');
    });
  }
}

// ─── SSE transport ─────────────────────────────────────────────────────
//
// MCP's HTTP+SSE transport is two-sided:
//   - Client opens SSE GET to `<url>` and reads server-pushed events.
//   - First event has `event: endpoint` with the URL path the client should
//     POST JSON-RPC requests to. All subsequent events are JSON-RPC
//     responses or notifications encoded as `event: message` data lines.
//   - Client POSTs outbound requests to the message endpoint.
//
// Built on Node 18+ `fetch` — no new deps. We buffer outbound sends until
// the endpoint event arrives so callers don't race the handshake.

class SseTransport implements McpTransport {
  private serverName: string;
  private sseUrl: string;
  private headers: Record<string, string>;
  private postUrl: string | null = null;
  private endpointPromise: Promise<void>;
  private resolveEndpoint!: () => void;
  private rejectEndpoint!: (err: Error) => void;
  private abortController = new AbortController();
  private handler: ((msg: JsonRpcResponse | JsonRpcNotification) => void) | null = null;
  private closed = false;

  constructor(serverName: string, url: string, headers?: Record<string, string>) {
    this.serverName = serverName;
    this.sseUrl = url;
    this.headers = headers ?? {};
    this.endpointPromise = new Promise((res, rej) => {
      this.resolveEndpoint = res;
      this.rejectEndpoint = rej;
    });
    void this.startSse();
  }

  private async startSse(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.sseUrl, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...this.headers },
        signal: this.abortController.signal,
      });
    } catch (err) {
      this.rejectEndpoint(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!res.ok || !res.body) {
      this.rejectEndpoint(new Error(`MCP SSE connect failed: ${res.status} ${res.statusText}`));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE messages are separated by blank lines.
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.parseSseEvent(raw);
        }
      }
    } catch (err) {
      if (!this.closed) {
        process.stderr.write(`[mcp:${this.serverName}] SSE read error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    } finally {
      if (!this.closed && !this.postUrl) {
        this.rejectEndpoint(new Error('SSE stream closed before endpoint event'));
      }
    }
  }

  private parseSseEvent(raw: string): void {
    const lines = raw.split('\n');
    let event = 'message';
    const dataParts: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue; // comment
      const colonIdx = line.indexOf(':');
      const field = colonIdx >= 0 ? line.slice(0, colonIdx) : line;
      const value = colonIdx >= 0 ? line.slice(colonIdx + 1).replace(/^ /, '') : '';
      if (field === 'event') event = value;
      else if (field === 'data') dataParts.push(value);
    }
    const data = dataParts.join('\n');

    if (event === 'endpoint') {
      // The server tells us where to POST. May be absolute or path-relative.
      try {
        this.postUrl = new URL(data, this.sseUrl).toString();
        this.resolveEndpoint();
      } catch (err) {
        this.rejectEndpoint(new Error(`invalid endpoint URL: ${data}`));
      }
    } else if (event === 'message' && data) {
      try {
        const msg = JSON.parse(data);
        this.handler?.(msg);
      } catch {
        process.stderr.write(`[mcp:${this.serverName}] non-JSON SSE data: ${data.slice(0, 200)}\n`);
      }
    }
  }

  async send(msg: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    await this.endpointPromise;
    if (!this.postUrl) throw new Error(`MCP SSE post endpoint not available for ${this.serverName}`);
    const res = await fetch(this.postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      throw new Error(`MCP SSE POST ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    }
  }

  onMessage(handler: (msg: JsonRpcResponse | JsonRpcNotification) => void): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortController.abort();
  }
}

// ─── Client ────────────────────────────────────────────────────────────

export class McpClient {
  private transport: McpTransport;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private connected = false;

  constructor(public readonly serverName: string, transport: McpTransport) {
    this.transport = transport;
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  static async connect(serverName: string, cfg: McpServerConfig): Promise<McpClient> {
    let transport: McpTransport;
    if ('command' in cfg) {
      transport = new StdioTransport(serverName, cfg.command, cfg.args, cfg.env, cfg.cwd);
    } else {
      transport = new SseTransport(serverName, cfg.url, cfg.headers);
    }
    const client = new McpClient(serverName, transport);
    await client.handshake();
    return client;
  }

  private async handshake(): Promise<void> {
    // initialize
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO,
    }, HANDSHAKE_TIMEOUT_MS);
    // initialized notification — no response expected
    await this.notify('notifications/initialized', {});
    this.connected = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    if (!this.connected) throw new Error(`MCP server ${this.serverName} not connected`);
    const result = await this.request('tools/list', {}) as { tools?: McpToolDef[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this.connected) throw new Error(`MCP server ${this.serverName} not connected`);
    return await this.request('tools/call', { name, arguments: args }) as McpToolCallResult;
  }

  async close(): Promise<void> {
    this.connected = false;
    // Reject any in-flight requests so callers don't hang.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server ${this.serverName} closed`));
    }
    this.pending.clear();
    await this.transport.close();
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveP, reject: rejectP, timer });
      this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectP(err);
      });
    });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.transport.send({ jsonrpc: '2.0', method, params });
  }

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    if ('id' in msg && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return; // late response, no-op
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }
    // Notifications (e.g. notifications/tools/list_changed) are quietly
    // ignored for now. A future enhancement is to refresh the tool registry
    // when a server signals its tool list changed.
  }
}

// ─── Discovery + tool wrapping ─────────────────────────────────────────

/** Convert MCP inputSchema (JSON Schema-style) into a Zod schema. Mirrors
 *  the same shape we use in src/tools/remote.ts so the rest of vcode treats
 *  the resulting ToolDef like any other tool. */
function buildZodFromMcpSchema(input: McpToolDef['inputSchema']): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  const required = new Set(input?.required ?? []);
  for (const [key, prop] of Object.entries(input?.properties ?? {})) {
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
    if (prop.description) field = field.describe(prop.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(shape);
}

/** Stringify MCP tool-call content for return to the model. Text becomes
 *  text; image/resource get a placeholder marker since the model can't
 *  consume them inline yet — Phase 4 image input may revisit this. */
function stringifyMcpContent(result: McpToolCallResult): string {
  if (!result.content || result.content.length === 0) return '';
  const parts: string[] = [];
  for (const c of result.content) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') parts.push(`[image: ${c.mimeType}, ${c.data.length}B base64]`);
    else if (c.type === 'resource') parts.push(c.resource.text ?? `[resource: ${c.resource.uri}]`);
  }
  return parts.join('\n');
}

/** Connect to all configured MCP servers and return their tools as ToolDefs.
 *  Failures are logged to stderr but don't abort startup — one bad server
 *  shouldn't bring vcode down. The caller is responsible for keeping the
 *  returned clients alive (closing them on shutdown). */
export async function connectAndDiscover(
  servers: Record<string, McpServerConfig>,
): Promise<{ clients: McpClient[]; tools: ToolDef[] }> {
  const clients: McpClient[] = [];
  const tools: ToolDef[] = [];

  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.disabled) continue;
    let client: McpClient;
    try {
      client = await McpClient.connect(name, cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp:${name}] connect failed: ${msg}\n`);
      continue;
    }
    clients.push(client);

    let mcpTools: McpToolDef[];
    try {
      mcpTools = await client.listTools();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp:${name}] tools/list failed: ${msg}\n`);
      continue;
    }

    const allow = cfg.allow && cfg.allow.length > 0 ? new Set(cfg.allow) : null;
    for (const def of mcpTools) {
      if (allow && !allow.has(def.name)) continue;
      // Namespace the tool name to prevent cross-server collisions and to
      // make provenance clear in tool-call traces. `mcp__filesystem__read_file`
      // is verbose but unambiguous; `/tools` shows the unprefixed name in
      // its source group for readability.
      const namespacedName = `mcp__${name}__${def.name}`;
      const schema = buildZodFromMcpSchema(def.inputSchema);
      tools.push({
        name: namespacedName,
        description: `[mcp:${name}] ${def.description ?? def.name}`,
        schema,
        source: 'mcp',
        sourceName: name,
        execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
          try {
            const result = await client.callTool(def.name, params);
            const text = stringifyMcpContent(result);
            if (result.isError) {
              return { success: false, output: '', error: text || 'MCP tool returned isError without content' };
            }
            return { success: true, output: text };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: '', error: `mcp:${name}/${def.name}: ${msg}` };
          }
        },
      });
    }
  }

  return { clients, tools };
}

/** Close all MCP clients in parallel. Called on TUI shutdown so child
 *  processes don't get orphaned. */
export async function closeAll(clients: McpClient[]): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.close()));
}
