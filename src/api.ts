import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { Agent } from './agent.js';
import type { ModelManager } from './models.js';
import type { ToolRegistry } from './tools/registry.js';

interface ApiConfig {
  port: number;
  host?: string; // bind address (default: 127.0.0.1)
  agent: Agent;
  modelManager: ModelManager;
  registry: ToolRegistry;
  apiToken?: string | null; // optional auth token; if set, all requests must include it
  apiExecute?: boolean; // enable /api/execute endpoint
  rcEnabled?: boolean; // enable Remote Connect (wider CORS, 0.0.0.0 bind)
  rcRequestHandler?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
}

/**
 * OpenAI-compatible API server that allows other tools (Claude Code, Gemini CLI,
 * Codex, etc.) to use VEEPEE Code as a backend with full tool access.
 *
 * Endpoints:
 *   POST /v1/chat/completions  — OpenAI-compatible chat (with tool execution)
 *   GET  /v1/models            — List available models
 *   GET  /api/tools            — List available tools
 *   GET  /api/status           — Session status
 *   POST /api/execute          — Execute a specific tool directly
 */
export function startApiServer(config: ApiConfig): { port: number; close: () => void } {
  const { agent, modelManager, registry } = config;

  const apiToken = config.apiToken || null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS — allow any origin when RC is enabled, localhost only otherwise
    const origin = req.headers.origin || '';
    if (config.rcEnabled) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check — if token is configured, require Bearer token
    // Skip auth for GET /rc (serves login page) and GET /rc/stream (has its own token check via query param)
    const reqPath = req.url?.split('?')[0] || '';
    const skipAuth = (reqPath === '/rc' && req.method === 'GET') || (reqPath === '/rc/stream' && req.method === 'GET');
    if (apiToken && !skipAuth) {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== apiToken) {
        sendJson(res, 401, { error: 'Unauthorized — set Authorization: Bearer <token>' });
        return;
      }
    }

    const url = new URL(req.url || '/', `http://localhost:${config.port}`);
    const path = url.pathname;

    try {
      // RC routes — handle first if enabled
      if (config.rcRequestHandler) {
        const handled = await config.rcRequestHandler(req, res, url);
        if (handled) return;
      }

      // OpenAI-compatible chat completions
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        const body = await readBody(req);
        const data = JSON.parse(body) as {
          model?: string;
          messages: Array<{ role: string; content: string }>;
          stream?: boolean;
          tools?: unknown[];
        };

        // Use specified model or current default
        if (data.model) {
          const profile = modelManager.getProfile(data.model);
          if (profile) {
            agent.setModel(data.model);
          }
        }

        // Extract the last user message
        const lastUserMsg = [...data.messages].reverse().find(m => m.role === 'user');
        if (!lastUserMsg) {
          sendJson(res, 400, { error: 'No user message found' });
          return;
        }

        // If client provides tool definitions, constrain agent to those tools only
        const userContent = lastUserMsg.content;
        let clientToolNames: string[] | null = null;
        if (data.tools && Array.isArray(data.tools) && data.tools.length > 0) {
          clientToolNames = data.tools
            .map((t: any) => t?.function?.name)
            .filter(Boolean) as string[];
        }
        // Set tool filter before running (cleared after)
        agent.setAllowedTools(clientToolNames);

        if (data.stream) {
          // Streaming response (SSE)
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          const model = modelManager.getCurrentModel();
          let fullContent = '';
          let toolCallIndex = -1;

          for await (const event of agent.run(userContent, { permissionMode: 'auto_allow' })) {
            if (event.type === 'text' && event.content) {
              fullContent += event.content;
              const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: { content: event.content },
                  finish_reason: null,
                }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (event.type === 'tool_call') {
              // Emit standard OpenAI tool_calls delta
              toolCallIndex++;
              const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: toolCallIndex,
                      id: `call_${Date.now()}_${toolCallIndex}`,
                      type: 'function',
                      function: {
                        name: event.name,
                        arguments: JSON.stringify(event.args || {}),
                      },
                    }],
                  },
                  finish_reason: null,
                }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (event.type === 'tool_result') {
              // Tool results aren't part of OpenAI streaming spec, but useful for clients
              const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: { content: '' },
                  finish_reason: null,
                }],
                veepee_code: {
                  tool_result: {
                    name: event.name,
                    success: event.success,
                    output: (event.content || '').slice(0, 1000),
                  },
                },
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (event.type === 'done') {
              const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              res.write('data: [DONE]\n\n');
            }
          }

          agent.setAllowedTools(null); // clear filter
          res.end();
          return;
        }

        // Non-streaming response
        const result = await agent.runSync(userContent, { permissionMode: 'auto_allow' });
        const model = modelManager.getCurrentModel();

        // Build standard OpenAI tool_calls array
        const toolCallsMsg = result.toolCalls.length > 0
          ? result.toolCalls.map((tc, i) => ({
              id: `call_${Date.now()}_${i}`,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            }))
          : undefined;

        sendJson(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: result.content,
              ...(toolCallsMsg ? { tool_calls: toolCallsMsg } : {}),
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        });
        agent.setAllowedTools(null); // clear filter
        return;
      }

      // List models (OpenAI-compatible)
      if (path === '/v1/models' && req.method === 'GET') {
        const models = modelManager.getAllModels();
        sendJson(res, 200, {
          object: 'list',
          data: models.map(m => ({
            id: m.name,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'ollama',
            capabilities: m.capabilities,
            tier: m.tier,
            parameter_size: m.parameterSize,
            score: m.score,
            is_loaded: m.isLoaded,
          })),
        });
        return;
      }

      // List tools
      if (path === '/api/tools' && req.method === 'GET') {
        const tools = registry.list();
        sendJson(res, 200, {
          tools: tools.map(t => ({
            name: t.name,
            description: t.description,
          })),
          count: tools.length,
        });
        return;
      }

      // Execute a tool directly — requires VEEPEE_CODE_API_EXECUTE=1 opt-in
      if (path === '/api/execute' && req.method === 'POST') {
        if (!config.apiExecute) {
          sendJson(res, 403, { error: '/api/execute is disabled. Set apiExecute to true in vcode.config.json to enable.' });
          return;
        }

        const body = await readBody(req);
        const data = JSON.parse(body) as { tool: string; args: Record<string, unknown> };

        if (!data.tool) {
          sendJson(res, 400, { error: 'tool is required' });
          return;
        }

        const result = await registry.execute(data.tool, data.args || {});
        sendJson(res, 200, result);
        return;
      }

      // Session status
      if (path === '/api/status' && req.method === 'GET') {
        sendJson(res, 200, {
          model: modelManager.getCurrentModel(),
          tools: registry.count(),
          messages: agent.getContext().messageCount(),
          tokens_estimate: agent.getContext().estimateTokens(),
          cwd: process.cwd(),
        });
        return;
      }

      // Health check
      if (path === '/' || path === '/health') {
        sendJson(res, 200, { status: 'ok', service: 'veepee-code' });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      config.port++;
      const bindHost = config.rcEnabled ? '0.0.0.0' : (config.host || '127.0.0.1');
  server.listen(config.port, bindHost);
    }
  });

  const bindHost = config.rcEnabled ? '0.0.0.0' : (config.host || '127.0.0.1');
  server.listen(config.port, bindHost);

  return {
    get port() { return config.port; },
    close: () => server.close(),
  };
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
