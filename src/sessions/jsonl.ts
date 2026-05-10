/**
 * JSONL tree-session storage. A single append-only file per session, where
 * each line is a typed entry with `id` and `parentId`. Branching, compaction,
 * and bookmarks are entries on the same stream — `/tree` navigation just
 * moves the active-leaf pointer.
 *
 * Format: each line is `JSON.stringify(entry) + '\n'`. The first line MUST
 * be a `meta` entry. The active leaf is stored in a sidecar `<id>.leaf` file
 * (one line, the leaf entry id) so leaf moves don't rewrite the JSONL.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import type { Message, ToolCall } from 'ollama';

export interface EntryBase {
  id: string;
  parentId: string | null;
  ts: number;
  type: string;
}

export interface MetaEntry extends EntryBase {
  type: 'meta';
  name: string;
  cwd: string;
  model: string;
  mode: string;
  createdAt: string;
  updatedAt?: string;
  schemaVersion: 1;
}

export interface MessageEntry extends EntryBase {
  type: 'message';
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  /** For role:'tool' results — name of the tool that produced this. */
  toolName?: string;
  /** Set true to keep this in the file but exclude from LLM context (e.g.
   *  silent !!cmd outputs, internal notices). */
  excludeFromContext?: boolean;
}

export interface CompactionEntry extends EntryBase {
  type: 'compaction';
  summary: string;
  /** Entry id of the first kept (post-summary) message. null = none kept. */
  firstKeptEntryId: string | null;
  tokensBefore: number;
  /** P3: cumulative file tracking across compactions. */
  details?: { readFiles: string[]; modifiedFiles: string[] };
}

export interface LabelEntry extends EntryBase {
  type: 'label';
  targetId: string;
  name: string;
}

export interface ModelChangeEntry extends EntryBase {
  type: 'model_change';
  from: string;
  to: string;
}

export interface ModeChangeEntry extends EntryBase {
  type: 'mode_change';
  from: string;
  to: string;
}

export interface CustomEntry extends EntryBase {
  type: 'custom';
  namespace: string;
  data: unknown;
}

export type SessionEntry =
  | MetaEntry
  | MessageEntry
  | CompactionEntry
  | LabelEntry
  | ModelChangeEntry
  | ModeChangeEntry
  | CustomEntry;

export type AppendableEntry =
  | Omit<MessageEntry, 'id' | 'ts' | 'parentId'>
  | Omit<CompactionEntry, 'id' | 'ts' | 'parentId'>
  | Omit<LabelEntry, 'id' | 'ts' | 'parentId'>
  | Omit<ModelChangeEntry, 'id' | 'ts' | 'parentId'>
  | Omit<ModeChangeEntry, 'id' | 'ts' | 'parentId'>
  | Omit<CustomEntry, 'id' | 'ts' | 'parentId'>;

export interface SessionMeta {
  name: string;
  cwd: string;
  model: string;
  mode: string;
  createdAt?: string;
}

function genId(): string {
  return randomBytes(8).toString('hex');
}

function leafPath(filePath: string): string {
  return filePath.replace(/\.jsonl$/, '') + '.leaf';
}

/**
 * A single JSONL session file. Keeps an in-memory index of entries by id, and
 * the current leaf id. All append operations are O(1); active-path
 * reconstruction is O(depth) by walking parentId pointers.
 */
export class JsonlSession {
  readonly filePath: string;
  private entries = new Map<string, SessionEntry>();
  private leafId: string;
  private metaId: string;

  private constructor(filePath: string, entries: SessionEntry[], leafId: string, metaId: string) {
    this.filePath = filePath;
    for (const e of entries) this.entries.set(e.id, e);
    this.leafId = leafId;
    this.metaId = metaId;
  }

  /** Open an existing session file. Throws if missing or no meta entry. */
  static open(filePath: string): JsonlSession {
    if (!existsSync(filePath)) {
      throw new Error(`Session file not found: ${filePath}`);
    }
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const entries: SessionEntry[] = [];
    let metaId: string | null = null;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        entries.push(entry);
        // Track the LATEST meta entry on disk — meta is chained, so the
        // newest line wins (`updateMeta` appends and chains via parentId).
        if (entry.type === 'meta') metaId = entry.id;
      } catch {
        // skip corrupt lines
      }
    }
    if (!metaId) throw new Error(`Session file has no meta entry: ${filePath}`);
    const lp = leafPath(filePath);
    let leafId: string;
    if (existsSync(lp)) {
      leafId = readFileSync(lp, 'utf-8').trim();
      if (!leafId || !entries.find(e => e.id === leafId)) {
        leafId = entries[entries.length - 1]?.id ?? metaId;
      }
    } else {
      leafId = entries[entries.length - 1]?.id ?? metaId;
    }
    return new JsonlSession(filePath, entries, leafId, metaId);
  }

  /** Create a new session file with the given metadata. The file (and its
   *  parent directory) are created on disk before this returns. */
  static create(filePath: string, meta: SessionMeta): JsonlSession {
    mkdirSync(dirname(filePath), { recursive: true });
    const id = genId();
    const now = Date.now();
    const metaEntry: MetaEntry = {
      id,
      parentId: null,
      ts: now,
      type: 'meta',
      name: meta.name,
      cwd: meta.cwd,
      model: meta.model,
      mode: meta.mode,
      createdAt: meta.createdAt ?? new Date(now).toISOString(),
      schemaVersion: 1,
    };
    writeFileSync(filePath, JSON.stringify(metaEntry) + '\n');
    writeFileSync(leafPath(filePath), id);
    return new JsonlSession(filePath, [metaEntry], id, id);
  }

  /** Append a new entry. parentId defaults to the current leaf; the new
   *  entry then becomes the leaf. Returns the materialized entry. */
  append(input: AppendableEntry, opts?: { parentId?: string | null }): SessionEntry {
    const id = genId();
    const ts = Date.now();
    const parentId = opts?.parentId !== undefined ? opts.parentId : this.leafId;
    const entry = { ...input, id, parentId, ts } as SessionEntry;
    this.entries.set(id, entry);
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    this.leafId = id;
    writeFileSync(leafPath(this.filePath), id);
    return entry;
  }

  /** Move the active leaf to an arbitrary entry. Used by `/tree` navigation
   *  — subsequent appends will branch off this point, leaving any previous
   *  branch intact in the file. */
  setLeaf(entryId: string): void {
    if (!this.entries.has(entryId)) {
      throw new Error(`Unknown entry id: ${entryId}`);
    }
    this.leafId = entryId;
    writeFileSync(leafPath(this.filePath), entryId);
  }

  /** Add a label (bookmark) on the given entry. Returns the label entry. */
  label(targetId: string, name: string): LabelEntry {
    if (!this.entries.has(targetId)) {
      throw new Error(`Cannot label unknown entry: ${targetId}`);
    }
    return this.append({ type: 'label', targetId, name }) as LabelEntry;
  }

  /** Get the active path (leaf → root, then reversed so [0] is the root). */
  getActivePath(): SessionEntry[] {
    const path: SessionEntry[] = [];
    let cur: SessionEntry | undefined = this.entries.get(this.leafId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push(cur);
      if (cur.parentId === null) break;
      cur = this.entries.get(cur.parentId);
    }
    return path.reverse();
  }

  /** Get all entries in append order (raw stream — for tree visualization). */
  getAllEntries(): SessionEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => a.ts - b.ts);
  }

  /** Resolve the active path to an Ollama-shape Message[] suitable for
   *  passing to the model. Walks compaction summaries: if a compaction is on
   *  the path, its summary replaces all messages between the prior boundary
   *  and the compaction's `firstKeptEntryId` (exclusive). */
  getMessages(): Message[] {
    const path = this.getActivePath();
    const messages: Message[] = [];

    // Find the most recent compaction on the path (latest wins). All entries
    // before its firstKeptEntryId are skipped, and the summary is injected
    // as a system message in their place.
    let lastCompaction: CompactionEntry | null = null;
    for (const e of path) {
      if (e.type === 'compaction') lastCompaction = e;
    }

    let skipUntilId: string | null = null;
    if (lastCompaction) {
      skipUntilId = lastCompaction.firstKeptEntryId;
      messages.push({ role: 'system', content: `[Compacted earlier conversation]\n${lastCompaction.summary}` });
    }

    let skipping = skipUntilId !== null;
    for (const e of path) {
      if (skipping) {
        if (e.id === skipUntilId) {
          skipping = false;
          // fall through and process this entry as the first kept message
        } else {
          continue;
        }
      }
      if (e.type !== 'message') continue;
      if (e.excludeFromContext) continue;
      const msg: Message = { role: e.role as Message['role'], content: e.content };
      if (e.toolCalls && e.toolCalls.length > 0) {
        (msg as unknown as { tool_calls: ToolCall[] }).tool_calls = e.toolCalls;
      }
      messages.push(msg);
    }
    return messages;
  }

  /** Fork: create a new session file with the path from root to `targetId`
   *  copied verbatim. The new session's leaf is `targetId`. */
  fork(targetId: string, newPath: string): JsonlSession {
    if (!this.entries.has(targetId)) {
      throw new Error(`Cannot fork unknown entry: ${targetId}`);
    }
    // Walk ancestry from targetId to root
    const ancestry: SessionEntry[] = [];
    let cur: SessionEntry | undefined = this.entries.get(targetId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      ancestry.push(cur);
      if (cur.parentId === null) break;
      cur = this.entries.get(cur.parentId);
    }
    ancestry.reverse();

    mkdirSync(dirname(newPath), { recursive: true });
    const lines = ancestry.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(newPath, lines);
    writeFileSync(leafPath(newPath), targetId);
    return JsonlSession.open(newPath);
  }

  /** Clone: duplicate the current active path into a new session file. The
   *  new session's leaf matches this session's current leaf. */
  clone(newPath: string): JsonlSession {
    return this.fork(this.leafId, newPath);
  }

  /** Read access to the current leaf id. */
  getLeafId(): string {
    return this.leafId;
  }

  /** Read access to the meta entry. */
  getMeta(): MetaEntry {
    return this.entries.get(this.metaId) as MetaEntry;
  }

  /** Update the meta entry's `updatedAt` and `name`/`model`/`mode` fields.
   *  Rewrites the meta line in place by appending a new meta entry — old
   *  meta is preserved for audit. */
  updateMeta(patch: Partial<Pick<MetaEntry, 'name' | 'model' | 'mode'>>): void {
    const meta = this.getMeta();
    const updated: MetaEntry = {
      ...meta,
      ...patch,
      id: genId(),
      parentId: meta.id, // chain meta entries via parent
      ts: Date.now(),
      type: 'meta',
      updatedAt: new Date().toISOString(),
    };
    this.entries.set(updated.id, updated);
    appendFileSync(this.filePath, JSON.stringify(updated) + '\n');
    this.metaId = updated.id;
  }

  /** Linear search across all entries. Useful for `/tree` filter modes and
   *  bookmark lookup. */
  search(predicate: (e: SessionEntry) => boolean): SessionEntry[] {
    const out: SessionEntry[] = [];
    for (const e of this.entries.values()) {
      if (predicate(e)) out.push(e);
    }
    return out;
  }

  /** Get all labels on the active path, mapped by target entry id. */
  getLabelsOnPath(): Map<string, LabelEntry[]> {
    const path = new Set(this.getActivePath().map(e => e.id));
    const out = new Map<string, LabelEntry[]>();
    for (const e of this.entries.values()) {
      if (e.type !== 'label') continue;
      if (!path.has(e.targetId)) continue;
      const list = out.get(e.targetId) ?? [];
      list.push(e);
      out.set(e.targetId, list);
    }
    return out;
  }

  /** Delete the session file and its leaf sidecar. */
  unlink(): void {
    try { unlinkSync(this.filePath); } catch {}
    try { unlinkSync(leafPath(this.filePath)); } catch {}
  }
}
