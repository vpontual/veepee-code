import { writeFile, readFile, readdir, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import type { Message } from 'ollama';
import type { AgentMode } from './agent.js';
import type { KnowledgeStateData } from './knowledge.js';
import { theme, icons } from './tui/index.js';

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

/** Save current session to disk */
export async function saveSession(
  name: string,
  messages: Message[],
  model: string,
  mode: AgentMode,
  cwd: string,
  existingId?: string,
  knowledgeState?: KnowledgeStateData,
): Promise<Session> {
  await mkdir(SESSIONS_DIR, { recursive: true });

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

/** Load a session by ID */
export async function loadSession(id: string): Promise<Session | null> {
  if (!existsSync(SESSIONS_DIR)) return null;

  const files = await readdir(SESSIONS_DIR);
  const match = files.find(f => f.startsWith(id));
  if (!match) return null;

  try {
    const data = await readFile(join(SESSIONS_DIR, match), 'utf-8');
    return JSON.parse(data) as Session;
  } catch {
    return null;
  }
}

/** List all saved sessions, newest first */
export async function listSessions(): Promise<Session[]> {
  if (!existsSync(SESSIONS_DIR)) return [];

  const files = await readdir(SESSIONS_DIR);
  const sessions: Session[] = [];

  for (const f of files) {
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
