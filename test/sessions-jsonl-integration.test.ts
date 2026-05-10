import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Stub the SESSIONS_DIR resolution to point at a temp dir for the duration
// of these tests — saveSession/loadSession use a module-scoped constant
// derived from $HOME, which we override with HOME env.
let homeDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'vcode-sessions-int-'));
  process.env.HOME = homeDir;
  // Bust module cache so SESSIONS_DIR is recomputed against the new HOME.
  vi.resetModules();
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('sessions.ts dual-format integration', () => {
  it('saves a JSONL session when options.jsonl is true', async () => {
    const { saveSession } = await import('../src/sessions.js');
    await saveSession(
      'my-session',
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      'qwen3',
      'act',
      '/some/cwd',
      undefined,
      undefined,
      { jsonl: true },
    );
    const files = readdirSync(join(homeDir, '.veepee-code', 'sessions'));
    expect(files.some(f => f.endsWith('.jsonl'))).toBe(true);
    expect(files.some(f => f.endsWith('.json'))).toBe(false);
  });

  it('saves a legacy JSON session when options.jsonl is false/unset', async () => {
    const { saveSession } = await import('../src/sessions.js');
    await saveSession('legacy', [{ role: 'user', content: 'x' }], 'm', 'act', '/c');
    const files = readdirSync(join(homeDir, '.veepee-code', 'sessions'));
    expect(files.some(f => f.endsWith('.json') && !f.endsWith('.jsonl'))).toBe(true);
  });

  it('loadSession reads JSONL and projects to the legacy Session shape', async () => {
    const { saveSession, loadSession } = await import('../src/sessions.js');
    const saved = await saveSession(
      'jsonl-test',
      [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
      'qwen3', 'act', '/some/cwd', undefined, undefined, { jsonl: true },
    );
    const loaded = await loadSession(saved.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].content).toBe('one');
    expect(loaded!.name).toBe('jsonl-test');
    expect(loaded!.model).toBe('qwen3');
  });

  it('listSessions returns both .json and .jsonl sessions', async () => {
    const { saveSession, listSessions } = await import('../src/sessions.js');
    await saveSession('legacy', [{ role: 'user', content: 'a' }], 'm', 'act', '/c');
    await saveSession('tree', [{ role: 'user', content: 'b' }], 'm', 'act', '/c', undefined, undefined, { jsonl: true });
    const all = await listSessions();
    const names = all.map(s => s.name).sort();
    expect(names).toEqual(['legacy', 'tree']);
  });

  it('saving twice with same id appends new tail to JSONL', async () => {
    const { saveSession, loadSession } = await import('../src/sessions.js');
    const first = await saveSession(
      'incr',
      [{ role: 'user', content: 'one' }],
      'm', 'act', '/c', undefined, undefined, { jsonl: true },
    );
    await saveSession(
      'incr',
      [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'two' },
      ],
      'm', 'act', '/c', first.id, undefined, { jsonl: true },
    );
    const loaded = await loadSession(first.id);
    expect(loaded!.messages.map(m => m.content)).toEqual(['one', 'reply', 'two']);

    // Verify file contains entries (one meta + 3 messages = at least 4 lines,
    // plus possible meta updates from updateMeta calls).
    const files = readdirSync(join(homeDir, '.veepee-code', 'sessions'));
    const jsonl = files.find(f => f.endsWith('.jsonl'))!;
    const lines = readFileSync(join(homeDir, '.veepee-code', 'sessions', jsonl), 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  it('loadJsonlSession returns the underlying tree session for /tree commands', async () => {
    const { saveSession, loadJsonlSession } = await import('../src/sessions.js');
    const s = await saveSession('t', [{ role: 'user', content: 'hi' }], 'm', 'act', '/c', undefined, undefined, { jsonl: true });
    const j = await loadJsonlSession(s.id);
    expect(j).not.toBeNull();
    expect(j!.getMessages().map(m => m.content)).toEqual(['hi']);
  });

  it('loadJsonlSession returns null for legacy .json sessions', async () => {
    const { saveSession, loadJsonlSession } = await import('../src/sessions.js');
    const s = await saveSession('legacy', [{ role: 'user', content: 'hi' }], 'm', 'act', '/c');
    const j = await loadJsonlSession(s.id);
    expect(j).toBeNull();
  });

  it('autoAppendJsonlTurn creates a fresh JSONL session on first call', async () => {
    const { autoAppendJsonlTurn, loadJsonlSession } = await import('../src/sessions.js');
    const result = await autoAppendJsonlTurn({
      currentSessionId: null,
      cwd: '/c',
      model: 'qwen3',
      mode: 'act',
      messages: [{ role: 'user', content: 'first message' }],
    });
    expect(result).not.toBeNull();
    expect(result!.name.length).toBeGreaterThan(0);
    const j = await loadJsonlSession(result!.id);
    expect(j).not.toBeNull();
    expect(j!.getMessages().map(m => m.content)).toEqual(['first message']);
  });

  it('autoAppendJsonlTurn diff-appends only new messages on existing JSONL', async () => {
    const { autoAppendJsonlTurn, loadJsonlSession } = await import('../src/sessions.js');
    const first = await autoAppendJsonlTurn({
      currentSessionId: null, cwd: '/c', model: 'm', mode: 'act',
      messages: [{ role: 'user', content: 'one' }],
    });
    await autoAppendJsonlTurn({
      currentSessionId: first!.id, cwd: '/c', model: 'm', mode: 'act',
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
    });
    const j = await loadJsonlSession(first!.id);
    expect(j!.getMessages().map(m => m.content)).toEqual(['one', 'two']);
    // Verify only ONE message entry was added on the second call (not two).
    const msgEntries = j!.getAllEntries().filter(e => e.type === 'message');
    expect(msgEntries.length).toBe(2);
  });

  it('autoAppendJsonlTurn is idempotent when nothing has changed', async () => {
    const { autoAppendJsonlTurn, loadJsonlSession } = await import('../src/sessions.js');
    const first = await autoAppendJsonlTurn({
      currentSessionId: null, cwd: '/c', model: 'm', mode: 'act',
      messages: [{ role: 'user', content: 'one' }],
    });
    const before = (await loadJsonlSession(first!.id))!.getAllEntries().length;
    // Call again with the same messages — should be a no-op for message entries
    await autoAppendJsonlTurn({
      currentSessionId: first!.id, cwd: '/c', model: 'm', mode: 'act',
      messages: [{ role: 'user', content: 'one' }],
    });
    const after = (await loadJsonlSession(first!.id))!.getAllEntries().length;
    // Same number of message entries (KS-only writes are skipped because
    // knowledgeState is undefined here)
    expect(after).toBe(before);
  });

  it('autoAppendJsonlTurn skips legacy .json sessions', async () => {
    const { saveSession, autoAppendJsonlTurn } = await import('../src/sessions.js');
    const legacy = await saveSession('legacy', [{ role: 'user', content: 'a' }], 'm', 'act', '/c');
    const result = await autoAppendJsonlTurn({
      currentSessionId: legacy.id, cwd: '/c', model: 'm', mode: 'act',
      messages: [{ role: 'user', content: 'a' }],
    });
    expect(result).toBeNull(); // skipped
    // No new .jsonl created for this id
    const files = readdirSync(join(homeDir, '.veepee-code', 'sessions'));
    expect(files.filter(f => f.startsWith(legacy.id) && f.endsWith('.jsonl'))).toHaveLength(0);
  });

  it('autoAppendJsonlTurn writes a knowledge custom entry when KS is provided', async () => {
    const { autoAppendJsonlTurn, loadJsonlSession } = await import('../src/sessions.js');
    const result = await autoAppendJsonlTurn({
      currentSessionId: null, cwd: '/c', model: 'm', mode: 'act',
      messages: [{ role: 'user', content: 'one' }],
      knowledgeState: { project: 'foo', cwd: '/c', userIntent: 'test', currentTask: 'testing', decisions: [], filesRead: [], filesModified: [], facts: [], errors: [], openQuestions: [], turn: 1 },
    });
    const j = (await loadJsonlSession(result!.id))!;
    const knowledge = j.getAllEntries().filter(e => e.type === 'custom' && (e as any).namespace === 'knowledge');
    expect(knowledge.length).toBe(1);
  });

  it('migrateLegacySessions converts .json → .jsonl and renames originals', async () => {
    const { saveSession, migrateLegacySessions, listSessions } = await import('../src/sessions.js');
    const a = await saveSession('alpha', [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }], 'm', 'act', '/c');
    const b = await saveSession('bravo', [{ role: 'user', content: 'three' }], 'm', 'act', '/c');

    const result = await migrateLegacySessions();
    expect(result.migrated.length).toBe(2);
    expect(result.errors).toHaveLength(0);

    const files = readdirSync(join(homeDir, '.veepee-code', 'sessions'));
    // Both originals renamed to .json.legacy
    expect(files.filter(f => f.endsWith('.json.legacy'))).toHaveLength(2);
    // Both have .jsonl counterparts
    expect(files.filter(f => f.endsWith('.jsonl'))).toHaveLength(2);

    // listSessions sees the JSONL versions, not the .json.legacy backups
    const sessions = await listSessions();
    expect(sessions.map(s => s.name).sort()).toEqual(['alpha', 'bravo']);
    expect(sessions.find(s => s.name === 'alpha')!.messages.map(m => m.content)).toEqual(['one', 'two']);
    expect(sessions.find(s => s.name === 'bravo')!.messages.map(m => m.content)).toEqual(['three']);
    void a; void b;
  });

  it('migrateLegacySessions skips sessions that already have a .jsonl counterpart', async () => {
    const { saveSession, migrateLegacySessions } = await import('../src/sessions.js');
    const { JsonlSession } = await import('../src/sessions/jsonl.js');
    // Create a legacy .json via saveSession
    const a = await saveSession('alpha', [{ role: 'user', content: 'one' }], 'm', 'act', '/c');
    // Manually create a .jsonl WITH THE SAME ID so both formats coexist
    const sessDir = join(homeDir, '.veepee-code', 'sessions');
    JsonlSession.create(join(sessDir, `${a.id}-alpha.jsonl`), { name: 'alpha', cwd: '/c', model: 'm', mode: 'act' });
    // Both files now exist for the same id
    const before = readdirSync(sessDir);
    expect(before.some(f => f.startsWith(a.id) && f.endsWith('.json'))).toBe(true);
    expect(before.some(f => f.startsWith(a.id) && f.endsWith('.jsonl'))).toBe(true);

    const result = await migrateLegacySessions();
    // The .json should be skipped (not migrated) because a .jsonl already exists
    expect(result.migrated.filter(f => f.startsWith(a.id))).toHaveLength(0);
    expect(result.skipped.some(f => f.startsWith(a.id) && f.endsWith('.json') && !f.endsWith('.legacy'))).toBe(true);
    // The original .json is still there (NOT renamed to .legacy because we didn't migrate)
    const after = readdirSync(sessDir);
    expect(after.some(f => f.startsWith(a.id) && f.endsWith('.json') && !f.endsWith('.legacy'))).toBe(true);
  });

  it('migrateLegacySessions is idempotent — running twice produces no extra files', async () => {
    const { saveSession, migrateLegacySessions } = await import('../src/sessions.js');
    await saveSession('x', [{ role: 'user', content: 'hi' }], 'm', 'act', '/c');
    const first = await migrateLegacySessions();
    const filesAfter1 = readdirSync(join(homeDir, '.veepee-code', 'sessions')).sort();
    const second = await migrateLegacySessions();
    const filesAfter2 = readdirSync(join(homeDir, '.veepee-code', 'sessions')).sort();
    expect(filesAfter1).toEqual(filesAfter2);
    expect(first.migrated).toHaveLength(1);
    expect(second.migrated).toHaveLength(0);
  });

  it('rewind via setLeaf followed by save preserves the abandoned branch', async () => {
    const { saveSession, loadJsonlSession } = await import('../src/sessions.js');
    const s = await saveSession(
      'branched',
      [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'old reply' },
        { role: 'user', content: 'two' },
      ],
      'm', 'act', '/c', undefined, undefined, { jsonl: true },
    );

    const j = (await loadJsonlSession(s.id))!;
    const path = j.getActivePath();
    // Path: meta, user(one), asst(old reply), user(two)
    const userOne = path.find(e => e.type === 'message' && (e as any).content === 'one')!;

    // Rewind to "one" — abandons "old reply" and "two"
    j.setLeaf(userOne.id);
    expect(j.getMessages().map(m => m.content)).toEqual(['one']);

    // Save with new branch from "one"
    await saveSession(
      'branched',
      [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'new reply' },
      ],
      'm', 'act', '/c', s.id, undefined, { jsonl: true },
    );

    const j2 = (await loadJsonlSession(s.id))!;
    expect(j2.getMessages().map(m => m.content)).toEqual(['one', 'new reply']);

    // The abandoned messages still exist as entries in the file
    const all = j2.getAllEntries();
    const allMessageContents = all.filter(e => e.type === 'message').map(e => (e as any).content);
    expect(allMessageContents).toContain('old reply');
    expect(allMessageContents).toContain('two');
  });
});
