/**
 * ACP server — Agent Client Protocol over stdio (JSON-RPC 2.0).
 * Zed spawns `vcode acp` and communicates over stdin/stdout.
 * All debug output goes to stderr; stdout is reserved for protocol messages.
 *
 * Phases 0-4: transport, lifecycle, prompt streaming, session persistence,
 *             permission delegation, mode/config control.
 */

import { createInterface } from 'readline';
import { AcpSessionStore, type AcpMcpServer } from './acp-session.js';
import type { AcpSession } from './acp-session.js';

const VERSION = '0.3.0';
const ACP_PROTOCOL_VERSION = 1;

// ── JSON-RPC types ────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ── Transport ─────────────────────────────────────────────────────────────────

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id: string | number | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

export function sendNotification(method: string, params: unknown): void {
  send({ jsonrpc: '2.0', method, params });
}

// ── Capability advertisement ──────────────────────────────────────────────────

function agentCapabilities() {
  return {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    // ACP schema: only close, list, resume are valid sessionCapability fields.
    // prompt/cancel are baseline; load is expressed via top-level loadSession.
    sessionCapabilities: {
      close: {},
      list: {},
      resume: {},
    },
  };
}

// ── Session setup payload (Phase 4) ──────────────────────────────────────────

function buildConfigOptions(session: AcpSession): object[] {
  const mm = session.agent.getModelManager();
  const currentModel = mm.getCurrentModel();
  const allModels = mm.getAllModels();
  const currentMode = session.agent.getMode();
  const currentEffort = session.agent.getEffort();

  return [
    {
      id: 'mode',
      name: 'Mode',
      description: 'Controls tool availability and reasoning behavior',
      category: 'mode',
      type: 'select',
      currentValue: currentMode,
      options: [
        { value: 'act',  name: 'Act',  description: 'Code and use tools' },
        { value: 'plan', name: 'Plan', description: 'Plan without mutating tools' },
        { value: 'chat', name: 'Chat', description: 'Conversation and read-only context' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: allModels.map(m => ({ value: m.name, name: m.name })),
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: currentEffort,
      options: [
        { value: 'low',    name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high',   name: 'High' },
      ],
    },
  ];
}

function buildModes(session: AcpSession): object {
  return {
    currentModeId: session.agent.getMode(),
    availableModes: [
      { id: 'act',  name: 'Act',  description: 'Code and use tools' },
      { id: 'plan', name: 'Plan', description: 'Plan without mutating tools' },
      { id: 'chat', name: 'Chat', description: 'Conversation and read-only context' },
    ],
  };
}

// ── History replay (session/load) ─────────────────────────────────────────────

type ReplayMessage = {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
};

function replayHistoryUpdates(
  messages: ReplayMessage[],
  sendUpdate: (update: object) => void,
): void {
  let counter = 0;
  const pending: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      sendUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: msg.content } });
    } else if (msg.role === 'assistant') {
      if (msg.content) {
        sendUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: msg.content } });
      }
      for (const tc of msg.tool_calls ?? []) {
        const name = tc.function.name;
        const args = tc.function.arguments ?? {};
        const callId = `replay_${++counter}`;
        pending.push(callId);
        sendUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: callId,
          title: formatToolTitle(name, args),
          kind: toolKind(name),
          status: 'completed',
          rawInput: args,
        });
      }
    } else if (msg.role === 'tool') {
      const callId = pending.shift() ?? `replay_${++counter}`;
      sendUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: msg.content ?? '' } }],
        rawOutput: { success: true, output: msg.content ?? '' },
      });
    }
    // system: not user-visible, skip
  }
}

// ── Prompt helpers ────────────────────────────────────────────────────────────

function normalizePrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return String(prompt ?? '');
  return prompt
    .map((b: unknown) => {
      if (!b || typeof b !== 'object') return '';
      const block = b as Record<string, unknown>;
      if (block.type === 'text') return String(block.text ?? '');
      if (block.type === 'resource') {
        const res = block.resource as Record<string, unknown> | undefined;
        return res?.text ? String(res.text) : '';
      }
      if (block.type === 'resource_link') {
        const name = String(block.name ?? block.title ?? block.uri ?? 'resource');
        return `[${name}]`;
      }
      return '';
    })
    .join('');
}

// ── Tool call helpers ─────────────────────────────────────────────────────────

function toolKind(name: string): string {
  if (/^(read_file|list_files?)$/.test(name)) return 'read';
  if (/^(write_file|edit_file|multi_edit|notebook_edit)$/.test(name)) return 'edit';
  if (/^(bash|run_bash?)$/.test(name)) return 'execute';
  if (/^(grep|glob|search_files?)$/.test(name)) return 'search';
  if (/^(web_fetch|web_search|fetch)$/.test(name)) return 'fetch';
  if (/^(git|docker)$/.test(name)) return 'execute';
  return 'other';
}

function formatToolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':   return `Read ${args.path ?? 'file'}`;
    case 'write_file':  return `Write ${args.path ?? 'file'}`;
    case 'edit_file':   return `Edit ${args.path ?? 'file'}`;
    case 'multi_edit':  return `Edit ${args.path ?? 'file'}`;
    case 'bash':
    case 'run_bash':    return `Run: ${String(args.command ?? '').slice(0, 60)}`;
    case 'glob':        return `Glob ${args.pattern ?? '**'}`;
    case 'grep':        return `Search for ${args.pattern ?? '...'}`;
    case 'web_search':  return `Search: ${args.query ?? '...'}`;
    case 'web_fetch':   return `Fetch ${args.url ?? '...'}`;
    case 'git':         return `git ${args.args ?? ''}`;
    default:            return name.replace(/_/g, ' ');
  }
}

// ── Method handlers ───────────────────────────────────────────────────────────

function handleInitialize(
  id: string | number | null,
  params: { protocolVersion?: number },
): void {
  const negotiated = Math.min(params.protocolVersion ?? 1, ACP_PROTOCOL_VERSION);
  sendResult(id, {
    protocolVersion: negotiated,
    agentCapabilities: agentCapabilities(),
    agentInfo: { name: 'vcode', title: 'VEEPEE Code', version: VERSION },
    authMethods: [],
  });
}

function handleAuthenticate(id: string | number | null): void {
  sendResult(id, {});
}

async function handleSessionNew(
  id: string | number | null,
  params: { cwd?: string; mcpServers?: AcpMcpServer[] },
  store: AcpSessionStore,
): Promise<void> {
  const cwd = params.cwd ?? process.cwd();
  try {
    const session = await store.create(cwd, params.mcpServers ?? []);
    sendResult(id, {
      sessionId: session.sessionId,
      configOptions: buildConfigOptions(session),
      modes: buildModes(session),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[acp] session/new failed: ${msg}\n`);
    sendError(id, -32603, `Failed to create session: ${msg}`);
  }
}

async function handleSessionClose(
  id: string | number | null,
  params: { sessionId?: string },
  store: AcpSessionStore,
): Promise<void> {
  if (!params.sessionId) { sendError(id, -32602, 'sessionId required'); return; }
  const closed = await store.close(params.sessionId);
  if (!closed) { sendError(id, -32602, `Unknown session: ${params.sessionId}`); return; }
  sendResult(id, {});
}

async function handleSessionList(
  id: string | number | null,
  store: AcpSessionStore,
): Promise<void> {
  try {
    const sessions = await store.list();
    sendResult(id, {
      sessions: sessions.map(s => ({
        sessionId: s.id,
        cwd: s.cwd,
        title: s.name,
        updatedAt: s.updatedAt,
      })),
      nextCursor: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(id, -32603, `Failed to list sessions: ${msg}`);
  }
}

async function handleSessionLoadOrResume(
  id: string | number | null,
  params: { sessionId?: string; cwd?: string; mcpServers?: AcpMcpServer[] },
  store: AcpSessionStore,
  replay: boolean,
): Promise<void> {
  if (!params.sessionId) { sendError(id, -32602, 'sessionId required'); return; }
  try {
    const result = await store.load(params.sessionId, params.cwd, params.mcpServers ?? []);
    if (!result) {
      sendError(id, -32602, `Session not found: ${params.sessionId}`);
      return;
    }
    const { session, storedSession } = result;
    if (replay) {
      // session.sessionId === params.sessionId (AcpSession.load passes storedId through)
      const sendUpdate = (update: object) =>
        sendNotification('session/update', { sessionId: session.sessionId, update });
      replayHistoryUpdates(storedSession.messages as ReplayMessage[], sendUpdate);
    }
    // ACP LoadSessionResponse / ResumeSessionResponse: no sessionId field
    sendResult(id, {
      configOptions: buildConfigOptions(session),
      modes: buildModes(session),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(id, -32603, `Failed to load session: ${msg}`);
  }
}

async function handleSessionPrompt(
  id: string | number,
  params: { sessionId?: string; prompt?: unknown },
  store: AcpSessionStore,
  callClient: (method: string, params: unknown) => Promise<unknown>,
): Promise<void> {
  const session = store.get(params.sessionId ?? '');
  if (!session) { sendError(id, -32602, `Unknown session: ${params.sessionId}`); return; }

  if (session.activePrompt !== null) {
    sendError(id, -32000, 'Session already has an active prompt');
    return;
  }

  const generation = session.nextGeneration();
  session.activePrompt = { requestId: id, generation, cancelled: false };

  const userMessage = normalizePrompt(params.prompt);
  let stopReason = 'end_turn';

  // Per-name queue: maps tool name → [toolCallId, ...] FIFO
  // Handles multiple calls of the same tool in one turn
  const pendingByName = new Map<string, string[]>();
  let toolCallCounter = 0;

  const mintId = (name: string): string => {
    const callId = `call_${++toolCallCounter}`;
    const q = pendingByName.get(name) ?? [];
    q.push(callId);
    pendingByName.set(name, q);
    return callId;
  };

  const resolveId = (name: string): string => {
    const q = pendingByName.get(name) ?? [];
    const callId = q.shift() ?? `call_unknown`;
    if (q.length === 0) pendingByName.delete(name);
    else pendingByName.set(name, q);
    return callId;
  };

  // Non-destructive peek — used by permission handler (tool_call already minted the id)
  const peekId = (name: string): string => pendingByName.get(name)?.[0] ?? 'call_unknown';

  // Delegate permission prompts to Zed's UI via session/request_permission
  session.permissions.setPromptHandler(async (toolName, args) => {
    const toolCallId = peekId(toolName);
    try {
      const resp = await callClient('session/request_permission', {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId,
          toolName,
          kind: toolKind(toolName),
          title: formatToolTitle(toolName, args),
          rawInput: args,
        },
        options: [
          { optionId: 'allow-once',   name: 'Allow once',   kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject-once',  name: 'Deny',         kind: 'reject_once' },
        ],
      }) as { outcome?: unknown };

      // ACP spec: { outcome: { outcome: 'selected', optionId: '...' } | { outcome: 'cancelled' } }
      // Defensive: also accept flat string outcome for non-spec clients
      const outcome = resp.outcome;
      let optionId: string | null = null;
      if (typeof outcome === 'string') {
        optionId = outcome;
      } else if (outcome && typeof outcome === 'object') {
        const o = outcome as Record<string, unknown>;
        if (o.outcome === 'cancelled') optionId = 'cancelled';
        else if (o.outcome === 'selected') optionId = String(o.optionId ?? '');
      }

      switch (optionId) {
        case 'allow-always': return 'always';
        case 'allow-once':   return 'yes';
        case 'cancelled':
          if (session.activePrompt) session.activePrompt.cancelled = true;
          session.agent.abort();
          return 'no';
        default: return 'no';
      }
    } catch {
      return 'no';
    }
  });

  const notify = (update: object) =>
    sendNotification('session/update', { sessionId: session.sessionId, update });

  // Qwen3.6 (vLLM without reasoning parser) emits thinking content as plain `text`
  // events, then emits `reset_stream` + `thinking` when it encounters `</think>`.
  // ACP has no retraction primitive, so we must buffer `text` events before the
  // first `thinking` event and discard them if `reset_stream` arrives first.
  // After `thinking` is seen, subsequent `text` events are real answer text and
  // are emitted immediately without buffering.
  let textBuffer = '';
  let seenThinking = false;

  const flushTextBuffer = () => {
    if (!textBuffer) return;
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textBuffer } });
    textBuffer = '';
  };

  try {
    for await (const event of session.agent.run(userMessage)) {
      if (session.activePrompt?.cancelled) { stopReason = 'cancelled'; break; }

      switch (event.type) {
        case 'text':
          if (seenThinking) {
            // Post-thinking phase: real answer text, emit immediately
            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.content ?? '' } });
          } else {
            // Pre-thinking phase: buffer in case this is orphan Qwen reasoning
            textBuffer += event.content ?? '';
          }
          break;

        case 'thinking':
          // Flush any real pre-think text (text before a `<think>` tag, not orphan thinking).
          // After reset_stream, textBuffer was cleared, so this is a no-op for orphan paths.
          flushTextBuffer();
          seenThinking = true;
          notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.content ?? '' } });
          break;

        case 'info':
          // Internal status message — not model reasoning, skip in Zed output.
          break;

        case 'reset_stream':
          // Orphan </think> detected — discard buffered text (it was reasoning content).
          // The `thinking` event that follows will carry the full reasoning.
          textBuffer = '';
          break;

        case 'tool_call': {
          // Flush any buffered text before announcing a tool call
          flushTextBuffer();
          const name = event.name ?? 'unknown';
          const callId = mintId(name);
          notify({
            sessionUpdate: 'tool_call',
            toolCallId: callId,
            title: formatToolTitle(name, event.args ?? {}),
            kind: toolKind(name),
            status: 'pending',
            rawInput: event.args ?? {},
          });
          break;
        }

        case 'tool_result': {
          const name = event.name ?? 'unknown';
          const callId = resolveId(name);
          const success = event.success !== false;
          notify({
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status: success ? 'completed' : 'failed',
            content: [{ type: 'content', content: { type: 'text', text: event.content ?? '' } }],
            rawOutput: { success, output: event.content ?? '', error: event.error },
          });
          // Reset thinking state — next LLM call starts fresh (orphan reasoning can occur again)
          textBuffer = '';
          seenThinking = false;
          break;
        }

        case 'permission_denied': {
          const name = event.name ?? 'unknown';
          const callId = resolveId(name);
          notify({
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status: 'failed',
            content: [{ type: 'content', content: { type: 'text', text: `Permission denied: ${name}` } }],
            rawOutput: { success: false, error: 'permission_denied' },
          });
          break;
        }

        case 'error':
          process.stderr.write(`[acp] agent error: ${event.error}\n`);
          break;

        case 'model_switch':
          // Notify Zed when ModelManager auto-switches mid-turn
          notify({
            sessionUpdate: 'config_option_update',
            configOption: {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: session.agent.getModelManager().getCurrentModel(),
              options: session.agent.getModelManager().getAllModels().map(m => ({ value: m.name, name: m.name })),
            },
          });
          break;

        case 'done':
        case 'hook_output':
          break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort|cancel/i.test(msg)) {
      stopReason = 'cancelled';
    } else {
      process.stderr.write(`[acp] run error: ${msg}\n`);
    }
  } finally {
    // Flush any remaining text buffer (non-thinking model: all text was buffered)
    flushTextBuffer();
    session.autoSave().catch(() => {});
    session.activePrompt = null;
    sendResult(id, { stopReason });
  }
}

async function handleSessionSetConfigOption(
  id: string | number | null,
  params: { sessionId?: string; configId?: string; value?: string },
  store: AcpSessionStore,
): Promise<void> {
  const session = store.get(params.sessionId ?? '');
  if (!session) { sendError(id, -32602, `Unknown session: ${params.sessionId}`); return; }
  if (!params.configId) { sendError(id, -32602, 'configId required'); return; }

  const value = String(params.value ?? '');
  try {
    switch (params.configId) {
      case 'model': {
        const mm = session.agent.getModelManager();
        if (!mm.getAllModels().some(m => m.name === value)) {
          sendError(id, -32602, `Unknown model: ${value}`); return;
        }
        session.agent.setModel(value);
        break;
      }
      case 'mode':
        if (value === 'plan') session.agent.enterPlanMode();
        else if (value === 'chat') session.agent.enterChatMode();
        else session.agent.exitPlanMode();
        break;
      case 'effort':
        if (value === 'low' || value === 'medium' || value === 'high') {
          session.agent.setEffort(value);
        } else {
          sendError(id, -32602, `Unknown effort level: ${value}`); return;
        }
        break;
      default:
        sendError(id, -32602, `Unknown configId: ${params.configId}`); return;
    }
    sendResult(id, { configOptions: buildConfigOptions(session) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(id, -32603, `Config update failed: ${msg}`);
  }
}

function handleSessionSetMode(
  id: string | number | null,
  params: { sessionId?: string; mode?: string },
  store: AcpSessionStore,
): void {
  // Thin compat wrapper — delegates to set_config_option logic
  handleSessionSetConfigOption(id, { sessionId: params.sessionId, configId: 'mode', value: params.mode }, store)
    .catch(() => {});
}

function handleSessionCancel(
  params: { sessionId?: string },
  store: AcpSessionStore,
): void {
  const session = store.get(params.sessionId ?? '');
  if (!session?.activePrompt) return;
  session.activePrompt.cancelled = true;
  session.agent.abort();
}

// ── Main dispatch loop ────────────────────────────────────────────────────────

export async function startAcpServer(): Promise<void> {
  const store = new AcpSessionStore();

  // Outbound agent→client call tracking (for session/request_permission, etc.)
  let clientCallCounter = 0;
  const pendingClientCalls = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const callClient = (method: string, callParams: unknown): Promise<unknown> => {
    const callId = `client_${++clientCallCounter}`;
    return new Promise((resolve, reject) => {
      pendingClientCalls.set(callId, { resolve, reject });
      send({ jsonrpc: '2.0', id: callId, method, params: callParams });
    });
  };

  process.on('exit', () => { store.closeAll().catch(() => {}); });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  process.stderr.write(`[acp] vcode ${VERSION} starting (ACP protocol v${ACP_PROTOCOL_VERSION})\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }

    const obj = parsed as Record<string, unknown>;

    // Incoming response to an outbound agent→client call (no 'method' field)
    if (!('method' in obj)) {
      const respId = obj['id'] as string | number | undefined;
      if (respId != null) {
        const pending = pendingClientCalls.get(respId);
        if (pending) {
          pendingClientCalls.delete(respId);
          if (obj['error']) {
            const err = obj['error'] as { message?: string };
            pending.reject(new Error(err.message ?? 'client error'));
          } else {
            pending.resolve(obj['result']);
          }
        }
      }
      continue;
    }

    let msg: JsonRpcRequest | JsonRpcNotification;
    try {
      msg = parsed as JsonRpcRequest | JsonRpcNotification;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }

    const isNotification = !('id' in msg);
    const id = isNotification ? null : (msg as JsonRpcRequest).id;
    const params = ((msg.params ?? {}) as Record<string, unknown>);

    process.stderr.write(`[acp] → ${msg.method}${isNotification ? ' (notification)' : ''}\n`);

    switch (msg.method) {
      case 'initialize':
        handleInitialize(id, params as { protocolVersion?: number });
        break;

      case 'authenticate':
        handleAuthenticate(id);
        break;

      case 'session/new':
        await handleSessionNew(id, params as { cwd?: string; mcpServers?: AcpMcpServer[] }, store);
        break;

      case 'session/close':
        await handleSessionClose(id, params as { sessionId?: string }, store);
        break;

      case 'session/list':
        await handleSessionList(id, store);
        break;

      case 'session/load':
        await handleSessionLoadOrResume(id, params as { sessionId?: string; cwd?: string; mcpServers?: AcpMcpServer[] }, store, true);
        break;

      case 'session/resume':
        await handleSessionLoadOrResume(id, params as { sessionId?: string; cwd?: string; mcpServers?: AcpMcpServer[] }, store, false);
        break;

      case 'session/prompt':
        if (isNotification || id === null) {
          process.stderr.write('[acp] session/prompt must have an id\n');
          break;
        }
        // Intentionally not awaited — runs in background while loop continues
        // reading (allows session/cancel to arrive while prompt is in progress)
        handleSessionPrompt(id, params as { sessionId?: string; prompt?: unknown }, store, callClient)
          .catch(err => process.stderr.write(`[acp] unhandled prompt error: ${err}\n`));
        break;

      case 'session/set_config_option':
        await handleSessionSetConfigOption(id, params as { sessionId?: string; configId?: string; value?: string }, store);
        break;

      case 'session/set_mode':
        handleSessionSetMode(id, params as { sessionId?: string; mode?: string }, store);
        break;

      case 'session/cancel':
        handleSessionCancel(params as { sessionId?: string }, store);
        break;

      default:
        if (!isNotification) sendError(id, -32601, `Method not found: ${msg.method}`);
    }
  }

  await store.closeAll();
}
