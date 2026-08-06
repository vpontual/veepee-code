import type { IncomingMessage, ServerResponse } from 'http';
import type { Agent, AgentEvent } from './agent.js';
import type { PermissionManager } from './permissions.js';
import type { PreviewManager } from './preview.js';
import { getRcHtml } from './rc-ui.js';
import { listSessions, findSession } from './sessions.js';
import { KnowledgeState } from './knowledge.js';
import { randomBytes } from 'crypto';
import { safeTokenEquals } from './auth.js';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { TurnQueue } from './turn-queue.js';
import { SessionRegistry } from './session-registry.js';

/**
 * One generation at a time, across every remote message.
 *
 * Module-scoped rather than per-request: the whole point is that two requests
 * share it. The TUI still calls agent.run() directly and still gets
 * AgentBusyError if it races a queued turn — the person at the keyboard can see
 * that the agent is working, so waiting silently would be the wrong default
 * there.
 */
const turnQueue = new TurnQueue();

// ─── Built web UI ──────────────────────────────────────────────────────────

/**
 * Where vite put the bundle: dist/web, beside this compiled module.
 *
 * Resolved from import.meta.url rather than process.cwd(), because the agent
 * chdirs into whatever project it is working on — a cwd-relative path here
 * would find the UI only when vcode happened to be started from its own repo.
 */
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'web');

/** The only names servable from WEB_DIR. An allow-list, so no path can traverse. */
const WEB_ASSETS = new Set(['app.js', 'app.css']);

function readWebAsset(name: string): string | null {
  const file = join(WEB_DIR, name);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

// ─── SSE Client Management ─────────────────────────────────────────────────

interface SseClient {
  res: ServerResponse;
  id: string;
}

const sseClients: SseClient[] = [];

/** Broadcast an SSE event to all connected RC clients */
function broadcast(eventType: string, data: unknown): void {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch { /* client disconnected */ }
  }
}

// ─── Remote Permission Queue ────────────────────────────────────────────────

interface PendingPermission {
  resolve: (decision: string) => void;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason?: string;
  timeout: ReturnType<typeof setTimeout>;
}

const permissionQueue = new Map<string, PendingPermission>();

/** Generate a unique call ID */
function generateCallId(): string {
  return randomBytes(8).toString('hex');
}

/** Generate a random token for RC access */
export function generateRcToken(): string {
  return randomBytes(16).toString('hex');
}

// ─── Route Registration ─────────────────────────────────────────────────────

export function registerRcRoutes(
  sharedAgent: Agent,
  permissions: PermissionManager,
  preview: PreviewManager,
  apiPort: number,
  apiToken: string | null,
  /**
   * Builds a fresh Agent for the remote client.
   *
   * When supplied, the phone gets its OWN conversation instead of continuing
   * whatever the laptop is in the middle of — and `/clear` from one no longer
   * wipes the other. When omitted, RC keeps sharing the TUI's agent exactly as
   * before, so nothing that already works has to change to adopt this.
   *
   * They still share one working directory: every filesystem tool resolves
   * against process.cwd(). Separate cwds per session is a much larger change.
   */
  createAgent?: () => Agent,
): {
  handleRequest: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  installPermissionHandler: () => void;
  onRemoteMessage: (handler: (message: string, events: AsyncGenerator<AgentEvent>) => void) => void;
  onRemoteCommand: (handler: (message: string) => Promise<void>) => void;
  onSessionChange: (handler: (sessionId: string, name: string) => void) => void;
} {

  let remoteMessageHandler: ((message: string, events: AsyncGenerator<AgentEvent>) => void) | null = null;
  let remoteCommandHandler: ((message: string) => Promise<void>) | null = null;
  let sessionChangeHandler: ((sessionId: string, name: string) => void) | null = null;

  /**
   * The agent every remote request runs against.
   *
   * One registry entry today — the phone is one client — but going through the
   * registry rather than holding an Agent directly is what makes adding a
   * second thread a routing change instead of a rewrite. Falls back to the
   * TUI's agent when no factory was given, preserving the old shared behaviour.
   */
  const sessions = createAgent ? new SessionRegistry(createAgent) : null;
  const REMOTE_SESSION_ID = 'remote';
  const agentFor = (): Agent => (sessions ? sessions.get(REMOTE_SESSION_ID) : sharedAgent);

  /** Check auth for RC routes */
  function checkAuth(req: IncomingMessage): boolean {
    if (!apiToken) return true;

    // Check header
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ') && safeTokenEquals(authHeader.slice(7), apiToken)) return true;

    // Check query param (for SSE which can't set headers)
    const url = new URL(req.url || '/', `http://localhost:${apiPort}`);
    if (safeTokenEquals(url.searchParams.get('token'), apiToken)) return true;

    return false;
  }

  function sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  function readBody(req: IncomingMessage): Promise<string> {
    const MAX_BODY = 1024 * 1024; // 1MB
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > MAX_BODY) {
          req.destroy();
          reject(new Error('Request body too large'));
        }
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /** Handle RC-related requests. Returns true if handled. */
  async function handleRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;

    // Serve the web UI.
    //
    // The built bundle when there is one, the legacy inline page otherwise —
    // `npm install` in web/ is not something a plain `install.sh` does, and an
    // RC that 404s because a build step was skipped is worse than an old UI.
    if ((path === '/rc' || path === '/rc/') && req.method === 'GET') {
      const bundled = readWebAsset('index.html');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(bundled ?? getRcHtml(apiPort, !!apiToken));
      return true;
    }

    // Static assets for that bundle.
    //
    // Deliberately BEFORE the auth check: these are the empty app shell, which
    // gives away nothing. Gating them would mean the browser cannot load the
    // very screen a user needs in order to enter their token. Every route that
    // returns or changes data stays behind auth below.
    if (req.method === 'GET' && WEB_ASSETS.has(path.slice('/rc/'.length))) {
      const name = path.slice('/rc/'.length);
      const body = readWebAsset(name);
      if (body) {
        res.writeHead(200, {
          'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/css',
          'Cache-Control': 'no-cache',
        });
        res.end(body);
        return true;
      }
    }

    // All other RC routes require auth
    if (path.startsWith('/rc/') && !checkAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }

    // SSE stream — mirrors agent events to web clients
    if (path === '/rc/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const clientId = generateCallId();
      const client: SseClient = { res, id: clientId };
      sseClients.push(client);

      // Send initial keepalive
      res.write(': connected\n\n');

      // Replay recent message history so the client catches up
      const recentMessages = agentFor().getContext().getAllMessages().slice(-20);
      for (const msg of recentMessages) {
        if (msg.role === 'user' && msg.content) {
          res.write(`event: history\ndata: ${JSON.stringify({ role: 'user', content: msg.content })}\n\n`);
        } else if (msg.role === 'assistant' && msg.content) {
          res.write(`event: history\ndata: ${JSON.stringify({ role: 'assistant', content: msg.content })}\n\n`);
        }
      }

      // Keepalive every 15s
      const keepalive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch { /* */ }
      }, 15000);

      req.on('close', () => {
        clearInterval(keepalive);
        const idx = sseClients.indexOf(client);
        if (idx >= 0) sseClients.splice(idx, 1);
      });

      return true;
    }

    // Send a message to the agent
    if (path === '/rc/send' && req.method === 'POST') {
      const body = await readBody(req);
      const data = JSON.parse(body) as { message: string; sessionId?: string };

      if (!data.message) {
        sendJson(res, 400, { error: 'message is required' });
        return true;
      }

      // The agent takes one run at a time — a second message mid-run would
      // interleave into the same context and steal the abort handle. Reject
      // before the ack so the phone shows a real failure, not a silent drop.
      // Slash commands are exempt: they go to the command handler, not the
      // agent loop.
      // A turn already in flight no longer means "your message is rejected".
      //
      // 409 was correct about the constraint — one generation at a time, which
      // is not negotiable on a single DGX — but wrong about whose problem it
      // is. It made the person holding the phone watch the transcript and
      // resend at the right moment. The message is queued instead, and the
      // queue depth is broadcast so the UI can say where it sits.
      //
      // Slash commands are still exempt: they go to the command handler, not
      // the agent loop, so they never contend for a generation.
      const willQueue = !data.message.trim().startsWith('/') && agentFor().isRunning();

      // Acknowledge receipt immediately
      sendJson(res, 200, { ok: true, queued: willQueue });

      if (data.message.trim().startsWith('/')) {
        broadcast('user_message', { content: data.message });
        if (!remoteCommandHandler) {
          broadcast('error_event', { error: 'Command handler is not ready' });
          return true;
        }
        remoteCommandHandler(data.message.trim())
          .then(() => broadcast('done', {}))
          .catch(err => broadcast('error_event', { error: String(err) }));
        return true;
      }

      // Run agent asynchronously — events broadcast to BOTH SSE clients and TUI
      // (agentFor().run() adds the user message to context internally).
      // The isRunning() check above already answered on the wire, so a lost
      // race here can only be reported over SSE.
      // Queued, not run. agentFor().run() is not called until the slot is free —
      // calling it early would throw AgentBusyError, and would also add the
      // message to context for a turn that has not started.
      if (willQueue) broadcast('queued', { ahead: turnQueue.state.waiting + 1 });
      const eventStream: AsyncGenerator<AgentEvent> = turnQueue.stream(() => agentFor().run(data.message));

      // Broadcast user message to SSE clients immediately
      broadcast('user_message', { content: data.message });

      if (remoteMessageHandler) {
        // TUI handler consumes the stream for laptop display;
        // we wrap it to also broadcast each event to SSE (phone)
        const teeEvents = async function* () {
          for await (const event of eventStream) {
            broadcastAgentEvent(event);
            yield event;
          }
        };
        remoteMessageHandler(data.message, teeEvents());
      } else {
        // No TUI handler — just broadcast to SSE clients
        (async () => {
          for await (const event of eventStream) {
            broadcastAgentEvent(event);
          }
        })().catch(err => {
          broadcast('error_event', { error: String(err) });
        });
      }

      return true;
    }

    // Abort the current generation
    if (path === '/rc/abort' && req.method === 'POST') {
      agentFor().abort();
      sendJson(res, 200, { ok: true });
      return true;
    }

    // List sessions
    if (path === '/rc/sessions' && req.method === 'GET') {
      const sessions = await listSessions();
      sendJson(res, 200, {
        sessions: sessions.slice(0, 20).map(s => ({
          id: s.id,
          name: s.name,
          messageCount: s.messageCount,
          updatedAt: s.updatedAt,
          model: s.model,
        })),
      });
      return true;
    }

    // Resume a session
    if (path === '/rc/resume' && req.method === 'POST') {
      const body = await readBody(req);
      const data = JSON.parse(body) as { sessionId: string };

      const session = await findSession(data.sessionId);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }

      // Clear and restore
      agentFor().clear();
      if (session.knowledgeState) {
        const ks = await KnowledgeState.load(session.id);
        if (ks) agentFor().getContext().setKnowledgeState(ks);
      }

      const recentMessages = session.messages.slice(-6);
      for (const msg of recentMessages) {
        if (msg.role === 'user') {
          agentFor().getContext().addUser(msg.content || '');
        } else if (msg.role === 'assistant') {
          agentFor().getContext().addAssistant(msg.content || '', msg.tool_calls);
        } else if (msg.role === 'tool') {
          agentFor().getContext().addToolResult('resumed', msg.content || '');
        }
      }

      sessionChangeHandler?.(session.id, session.name);
      sendJson(res, 200, { ok: true, name: session.name, messageCount: session.messageCount });
      return true;
    }

    // Approve/deny a permission request
    if (path === '/rc/approve' && req.method === 'POST') {
      const body = await readBody(req);
      const data = JSON.parse(body) as { callId: string; decision: 'y' | 'n' | 'a' };

      const pending = permissionQueue.get(data.callId);
      if (pending) {
        clearTimeout(pending.timeout);
        permissionQueue.delete(data.callId);
        pending.resolve(data.decision);
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 404, { error: 'Permission request not found or expired' });
      }
      return true;
    }

    // Preview a file (returns URL or output)
    if (path === '/rc/preview' && req.method === 'POST') {
      const body = await readBody(req);
      const data = JSON.parse(body) as { file: string };

      try {
        const result = await preview.run(data.file);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    return false; // not an RC route
  }

  /** Broadcast an agent event to SSE clients */
  function broadcastAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'text':
        if (event.content) broadcast('text', { content: event.content });
        break;
      case 'tool_call':
        broadcast('tool_call', { name: event.name, args: event.args });
        break;
      case 'tool_result':
        broadcast('tool_result', { name: event.name, success: event.success, output: (event.content || event.error || '').slice(0, 1000) });
        break;
      case 'done':
        broadcast('done', { evalCount: event.evalCount, tokensPerSecond: event.tokensPerSecond });
        break;
      case 'error':
        broadcast('error_event', { error: event.error });
        break;
      case 'thinking':
        broadcast('text', { content: '' }); // just a pulse
        break;
    }
  }

  /** Install a permission handler that routes to RC web clients */
  function installPermissionHandler(): void {
    // Only override if there are RC clients connected
    const originalHandler = permissions['promptHandler'];

    permissions.setPromptHandler(async (toolName, args, reason) => {
      // If RC clients are connected, send permission request to web UI
      if (sseClients.length > 0) {
        const callId = generateCallId();

        return new Promise<string>((resolve) => {
          const timeout = setTimeout(() => {
            permissionQueue.delete(callId);
            resolve('n'); // auto-deny after 60s
          }, 60_000);

          permissionQueue.set(callId, { resolve, callId, toolName, args, reason, timeout });

          broadcast('permission_request', {
            callId,
            toolName,
            args,
            reason,
          });
        });
      }

      // Fall back to TUI prompt if no RC clients
      if (originalHandler) {
        return originalHandler(toolName, args, reason);
      }
      return 'y'; // no handler at all → allow
    });
  }

  return {
    handleRequest,
    installPermissionHandler,
    onRemoteMessage: (handler: (message: string, events: AsyncGenerator<AgentEvent>) => void) => {
      remoteMessageHandler = handler;
    },
    onRemoteCommand: (handler: (message: string) => Promise<void>) => {
      remoteCommandHandler = handler;
    },
    onSessionChange: (handler: (sessionId: string, name: string) => void) => {
      sessionChangeHandler = handler;
    },
  };
}
