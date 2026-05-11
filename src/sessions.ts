import { writeFile, readFile, readdir, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import type { Message, ToolCall } from 'ollama';
import type { AgentMode } from './agent.js';
import type { KnowledgeStateData } from './knowledge.js';
import { theme, icons } from './tui/theme.js';
import { JsonlSession } from './sessions/jsonl.js';

export interface Session {
  id: string;
  name: string;
  model: string;
  mode: AgentMode;
  cwd: string;
  messages: Message[];
  knowledgeState?: KnowledgeStateData;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  toolCallCount: number;
}

const SESSIONS_DIR = resolve(process.env.HOME || '~', '.veepee-code', 'sessions');

/** Get the sessions directory path (used by sync) */
export function getSessionDir(): string {
  return SESSIONS_DIR;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function messageKey(message: Message): string {
  return JSON.stringify({
    role: message.role,
    content: message.content || '',
    tool_calls: message.tool_calls || [],
  });
}

function findNewMessageTail(stored: Message[], current: Message[]): Message[] {
  if (current.length === 0) return [];
  if (stored.length === 0) return current;

  const storedKeys = stored.map(messageKey);
  const currentKeys = current.map(messageKey);
  const maxOverlap = Math.min(storedKeys.length, currentKeys.length);

  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    let matches = true;
    const storedStart = storedKeys.length - overlap;
    for (let i = 0; i < overlap; i++) {
      if (storedKeys[storedStart + i] !== currentKeys[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return current.slice(overlap);
  }

  // A reset or clear can leave no overlap with the stored active path. Keep
  // saving the new context instead of dropping it based on the old file length.
  return current;
}

/** Save current session to disk */
export async function saveSession(
  name: string,
  messages: Message[],
  model: string,
  mode: AgentMode,
  cwd: string,
  existingId?: string,
  knowledgeState?: KnowledgeStateData,
  options?: { jsonl?: boolean },
): Promise<Session> {
  await mkdir(SESSIONS_DIR, { recursive: true });

  // JSONL path: write/append entries to a `<id>-<slug>.jsonl` file. Branches
  // and labels live inside that single file. KnowledgeState is folded in via
  // a `knowledge` custom entry (see jsonl.ts AppendableEntry shape).
  if (options?.jsonl) {
    return saveSessionJsonl(name, messages, model, mode, cwd, existingId, knowledgeState);
  }

  const now = new Date().toISOString();
  const toolCallCount = messages.filter(m => m.tool_calls && m.tool_calls.length > 0).length;

  const session: Session = {
    id: existingId || generateId(),
    name,
    model,
    mode,
    cwd,
    messages,
    knowledgeState,
    createdAt: existingId ? (await loadSession(existingId))?.createdAt || now : now,
    updatedAt: now,
    messageCount: messages.length,
    toolCallCount,
  };

  const filename = `${session.id}-${slugify(name)}.json`;
  const filepath = join(SESSIONS_DIR, filename);

  // If updating existing session, remove old file first (name might have changed)
  if (existingId) {
    const files = await readdir(SESSIONS_DIR).catch(() => []);
    for (const f of files) {
      if (f.startsWith(existingId)) {
        const { unlink } = await import('fs/promises');
        await unlink(join(SESSIONS_DIR, f)).catch(() => {});
      }
    }
  }

  await writeFile(filepath, JSON.stringify(session, null, 2));
  return session;
}

/** JSONL save path: append-only writes to a single tree-session file.
 *
 * Strategy: if the file doesn't exist, create it and write every in-memory
 * message as its own entry. If it exists, diff the in-memory message count
 * against the stored active path; append only the new tail. This makes
 * /save idempotent and incremental — the JSONL file accumulates branches
 * across /tree rewinds without rewriting history.
 *
 * Falls through to the legacy JSON path when the file extension is `.json`
 * (an existing session loaded as legacy continues that way).
 */
async function saveSessionJsonl(
  name: string,
  messages: Message[],
  model: string,
  mode: AgentMode,
  cwd: string,
  existingId?: string,
  knowledgeState?: KnowledgeStateData,
): Promise<Session> {
  const id = existingId || generateId();
  const filename = `${id}-${slugify(name)}.jsonl`;
  const filepath = join(SESSIONS_DIR, filename);

  let session: JsonlSession;
  if (existsSync(filepath)) {
    session = JsonlSession.open(filepath);
    session.updateMeta({ name, model, mode });
    // Compute diff by overlap. Resumed sessions keep only a sliding window in
    // memory, while the JSONL file stores the full active path.
    const stored = session.getMessages();
    const newTail = findNewMessageTail(stored, messages);
    appendMessageEntries(session, newTail);
  } else {
    // Look for legacy file we might be migrating from — rare path: an old
    // session id was passed but we want JSONL. Re-create with the messages
    // we have; legacy file is left alone (caller can /sessions list both).
    const matchedLegacy = await findExistingFileForId(id);
    if (matchedLegacy && matchedLegacy.endsWith('.json')) {
      // Rename legacy out of the way so /sessions doesn't show duplicates.
      const { rename } = await import('fs/promises');
      await rename(matchedLegacy, matchedLegacy + '.legacy').catch(() => {});
    }
    session = JsonlSession.create(filepath, { name, cwd, model, mode });
    appendMessageEntries(session, messages);
  }

  if (knowledgeState) {
    session.append({ type: 'custom', namespace: 'knowledge', data: knowledgeState });
  }

  const meta = session.getMeta();
  const toolCallCount = messages.filter(m => m.tool_calls && m.tool_calls.length > 0).length;
  return {
    id,
    name,
    model,
    mode,
    cwd,
    messages,
    knowledgeState,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt ?? meta.createdAt,
    messageCount: messages.length,
    toolCallCount,
  };
}

function appendMessageEntries(session: JsonlSession, msgs: Message[]): void {
  for (const m of msgs) {
    const role = (m.role || 'user') as 'user' | 'assistant' | 'tool' | 'system';
    const content = m.content ?? '';
    const toolCalls = (m as unknown as { tool_calls?: ToolCall[] }).tool_calls;
    const toolName = (m as unknown as { tool_name?: string }).tool_name;
    const entry: Parameters<typeof session.append>[0] = {
      type: 'message',
      role,
      content,
    };
    if (toolCalls && toolCalls.length > 0) (entry as { toolCalls?: ToolCall[] }).toolCalls = toolCalls;
    if (toolName) (entry as { toolName?: string }).toolName = toolName;
    session.append(entry);
  }
}

async function findExistingFileForId(id: string): Promise<string | null> {
  if (!existsSync(SESSIONS_DIR)) return null;
  const files = await readdir(SESSIONS_DIR).catch(() => []);
  const match = files.find(f => f.startsWith(id));
  return match ? join(SESSIONS_DIR, match) : null;
}

/** Load a JsonlSession instance by id (returns null if not JSONL or missing). */
export async function loadJsonlSession(id: string): Promise<JsonlSession | null> {
  const file = await findExistingFileForId(id);
  if (!file || !file.endsWith('.jsonl')) return null;
  try {
    return JsonlSession.open(file);
  } catch {
    return null;
  }
}

/** Migrate all legacy `.json` sessions in SESSIONS_DIR to `.jsonl`. The
 *  original file is renamed to `.json.legacy` so it's preserved but no
 *  longer shows up in `listSessions()` or sync. Idempotent — sessions
 *  already in JSONL format or already migrated are skipped. */
export async function migrateLegacySessions(): Promise<{ migrated: string[]; skipped: string[]; errors: Array<{ file: string; error: string }> }> {
  const result = { migrated: [] as string[], skipped: [] as string[], errors: [] as Array<{ file: string; error: string }> };
  if (!existsSync(SESSIONS_DIR)) return result;

  const files = await readdir(SESSIONS_DIR);
  const { rename } = await import('fs/promises');

  for (const f of files) {
    // Skip non-legacy: not .json, or already a .json.legacy backup
    if (!f.endsWith('.json')) {
      result.skipped.push(f);
      continue;
    }
    const fullPath = join(SESSIONS_DIR, f);
    try {
      const data = await readFile(fullPath, 'utf-8');
      const session = JSON.parse(data) as Session;
      // Already-migrated check: if a .jsonl exists for this id, skip.
      const existingJsonl = files.find(x => x.startsWith(session.id) && x.endsWith('.jsonl'));
      if (existingJsonl) {
        result.skipped.push(f);
        continue;
      }
      const newPath = join(SESSIONS_DIR, `${session.id}-${slugify(session.name)}.jsonl`);
      const j = JsonlSession.create(newPath, {
        name: session.name,
        cwd: session.cwd,
        model: session.model,
        mode: session.mode,
        createdAt: session.createdAt,
      });
      appendMessageEntries(j, session.messages);
      if (session.knowledgeState) {
        j.append({ type: 'custom', namespace: 'knowledge', data: session.knowledgeState });
      }
      // Rename original out of the way (preserves it for rollback)
      await rename(fullPath, fullPath + '.legacy').catch(() => {});
      result.migrated.push(f);
    } catch (err) {
      result.errors.push({ file: f, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * Per-turn auto-append for JSONL sessions. Closes the loop on "no lost work
 * after a crash" by appending new messages (diff against on-disk active path)
 * after every agent turn — without requiring an explicit `/save`.
 *
 * Behavior:
 *  - currentSessionId null → create a new JSONL session (auto-named from the
 *    first user message) and return its id+name so the caller can update its
 *    `currentSessionId` state.
 *  - currentSessionId points at a JSONL → diff-append new messages, refresh
 *    model/mode metadata if changed, append KS as a `knowledge` custom entry.
 *  - currentSessionId points at a legacy `.json` → skip (caller can /save
 *    manually). Returns null. Existing legacy session is left alone — we don't
 *    convert behind the user's back.
 *
 * Idempotent if no new messages have been added since the last append.
 */
export async function autoAppendJsonlTurn(args: {
  currentSessionId: string | null;
  cwd: string;
  model: string;
  mode: AgentMode;
  messages: Message[];
  knowledgeState?: KnowledgeStateData;
}): Promise<{ id: string; name: string } | null> {
  const { currentSessionId, cwd, model, mode, messages, knowledgeState } = args;
  if (messages.length === 0) return null;

  // Existing JSONL → diff and append.
  if (currentSessionId) {
    const file = await findExistingFileForId(currentSessionId);
    if (file && file.endsWith('.jsonl')) {
      try {
        const existing = JsonlSession.open(file);
        const stored = existing.getMessages();
        const newTail = findNewMessageTail(stored, messages);
        if (newTail.length > 0) appendMessageEntries(existing, newTail);
        const meta = existing.getMeta();
        if (meta.model !== model || meta.mode !== mode) {
          existing.updateMeta({ model, mode });
        }
        if (knowledgeState) {
          existing.append({ type: 'custom', namespace: 'knowledge', data: knowledgeState });
        }
        return { id: currentSessionId, name: meta.name };
      } catch {
        return null;
      }
    }
    if (file && file.endsWith('.json')) {
      // Legacy session — don't auto-convert. User can /save manually.
      return null;
    }
  }

  // Fresh session — auto-create a new JSONL.
  await mkdir(SESSIONS_DIR, { recursive: true });
  const name = autoName(messages);
  const id = currentSessionId ?? generateId();
  const filename = `${id}-${slugify(name)}.jsonl`;
  const filepath = join(SESSIONS_DIR, filename);
  const session = JsonlSession.create(filepath, { name, cwd, model, mode });
  appendMessageEntries(session, messages);
  if (knowledgeState) {
    session.append({ type: 'custom', namespace: 'knowledge', data: knowledgeState });
  }
  return { id, name };
}

/** Load a session by ID. Auto-detects format by file extension — `.jsonl`
 *  files are loaded via JsonlSession and projected back to the legacy
 *  Session shape; `.json` files are parsed as before. */
export async function loadSession(id: string): Promise<Session | null> {
  if (!existsSync(SESSIONS_DIR)) return null;

  const files = await readdir(SESSIONS_DIR);
  const match = files.find(f => f.startsWith(id) && (f.endsWith('.json') || f.endsWith('.jsonl')));
  if (!match) return null;

  if (match.endsWith('.jsonl')) {
    try {
      const session = JsonlSession.open(join(SESSIONS_DIR, match));
      return projectJsonlToSession(id, session);
    } catch {
      return null;
    }
  }

  try {
    const data = await readFile(join(SESSIONS_DIR, match), 'utf-8');
    return JSON.parse(data) as Session;
  } catch {
    return null;
  }
}

/** Project a JsonlSession's active path to a legacy Session shape so callers
 *  that expect Session don't need to know about the storage format. */
function projectJsonlToSession(id: string, j: JsonlSession): Session {
  const meta = j.getMeta();
  const messages = j.getMessages();
  const toolCallCount = messages.filter(m => (m as unknown as { tool_calls?: unknown[] }).tool_calls?.length).length;
  // Recover knowledgeState from the most recent `knowledge` custom entry on
  // the active path, if any.
  let knowledgeState: KnowledgeStateData | undefined;
  for (const e of j.getActivePath()) {
    if (e.type === 'custom' && (e as unknown as { namespace?: string }).namespace === 'knowledge') {
      knowledgeState = (e as unknown as { data: KnowledgeStateData }).data;
    }
  }
  return {
    id,
    name: meta.name,
    model: meta.model,
    mode: meta.mode as AgentMode,
    cwd: meta.cwd,
    messages,
    knowledgeState,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt ?? meta.createdAt,
    messageCount: messages.length,
    toolCallCount,
  };
}

/** List all saved sessions, newest first. Includes both `.json` (legacy) and
 *  `.jsonl` (tree) formats. */
export async function listSessions(): Promise<Session[]> {
  if (!existsSync(SESSIONS_DIR)) return [];

  const files = await readdir(SESSIONS_DIR);
  const sessions: Session[] = [];

  for (const f of files) {
    if (f.endsWith('.jsonl')) {
      try {
        const j = JsonlSession.open(join(SESSIONS_DIR, f));
        // Filename: <id>-<slug>.jsonl
        const id = f.split('-')[0];
        sessions.push(projectJsonlToSession(id, j));
      } catch {
        // skip corrupt files
      }
      continue;
    }
    if (!f.endsWith('.json')) continue;
    try {
      const data = await readFile(join(SESSIONS_DIR, f), 'utf-8');
      const session = JSON.parse(data) as Session;
      sessions.push(session);
    } catch {
      // skip corrupt files
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Delete a session by ID */
export async function deleteSession(id: string): Promise<boolean> {
  if (!existsSync(SESSIONS_DIR)) return false;

  const files = await readdir(SESSIONS_DIR);
  const match = files.find(f => f.startsWith(id));
  if (!match) return false;

  const { unlink } = await import('fs/promises');
  await unlink(join(SESSIONS_DIR, match));
  return true;
}

/** Find a session by name (fuzzy match) */
export async function findSession(query: string): Promise<Session | null> {
  const sessions = await listSessions();
  const lower = query.toLowerCase();

  // Exact match first
  const exact = sessions.find(s => s.name.toLowerCase() === lower);
  if (exact) return exact;

  // Starts-with match
  const starts = sessions.find(s => s.name.toLowerCase().startsWith(lower));
  if (starts) return starts;

  // Contains match
  const contains = sessions.find(s => s.name.toLowerCase().includes(lower));
  return contains || null;
}

/** Format session list for TUI display */
export function formatSessionList(sessions: Session[]): string {
  if (sessions.length === 0) {
    return `${theme.dim('  No saved sessions. Use /save [name] to save your conversation.')}`;
  }

  const lines: string[] = ['', theme.textBold('  Sessions'), ''];

  for (const s of sessions) {
    const age = formatAge(s.updatedAt);
    const msgCount = `${s.messageCount} msgs`;
    const toolCount = s.toolCallCount > 0 ? `, ${s.toolCallCount} tool calls` : '';

    lines.push(
      `  ${theme.accent(s.name.padEnd(30))} ${theme.dim(age.padEnd(8))} ${theme.dim(`${msgCount}${toolCount}`)}`
    );
    lines.push(
      `  ${theme.dimmer(`ID: ${s.id}  Model: ${s.model}  CWD: ${s.cwd}`)}`
    );
    lines.push('');
  }

  lines.push(theme.dim(`  ${sessions.length} session${sessions.length === 1 ? '' : 's'} | /resume <name> to continue | /save to update`));
  lines.push('');

  return lines.join('\n');
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

/** Auto-generate a session name from the first user message */
export function autoName(messages: Message[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser || !firstUser.content) return 'Untitled session';

  const text = firstUser.content.trim();
  // Take first 40 chars, break at word boundary
  if (text.length <= 40) return text;
  const truncated = text.slice(0, 40);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '...';
}
