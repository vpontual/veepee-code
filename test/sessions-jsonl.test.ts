import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonlSession } from '../src/sessions/jsonl.js';

describe('JsonlSession', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcode-jsonl-'));
    path = join(dir, 'session.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new session with a meta entry on the first line', () => {
    const s = JsonlSession.create(path, {
      name: 'test', cwd: '/tmp', model: 'qwen3', mode: 'act',
    });
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const meta = JSON.parse(lines[0]);
    expect(meta.type).toBe('meta');
    expect(meta.parentId).toBeNull();
    expect(s.getMeta().name).toBe('test');
  });

  it('append() chains parentId to current leaf and advances the leaf', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    const meta = s.getMeta();
    const a = s.append({ type: 'message', role: 'user', content: 'hello' });
    expect(a.parentId).toBe(meta.id);
    expect(s.getLeafId()).toBe(a.id);
    const b = s.append({ type: 'message', role: 'assistant', content: 'hi' });
    expect(b.parentId).toBe(a.id);
    expect(s.getLeafId()).toBe(b.id);
  });

  it('persists and reopens the session correctly', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    s.append({ type: 'message', role: 'user', content: 'one' });
    s.append({ type: 'message', role: 'assistant', content: 'two' });
    const reopened = JsonlSession.open(path);
    const msgs = reopened.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('one');
    expect(msgs[1].content).toBe('two');
  });

  it('setLeaf() rewinds; new appends branch off the new leaf', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    const a = s.append({ type: 'message', role: 'user', content: 'one' });
    s.append({ type: 'message', role: 'assistant', content: 'first reply' });
    s.append({ type: 'message', role: 'user', content: 'two' });
    s.append({ type: 'message', role: 'assistant', content: 'second reply' });

    // Rewind to entry `a`
    s.setLeaf(a.id);
    expect(s.getLeafId()).toBe(a.id);

    // The active path now ends at `a`
    const msgs = s.getMessages();
    expect(msgs.map(m => m.content)).toEqual(['one']);

    // New append branches off `a`
    const branch = s.append({ type: 'message', role: 'assistant', content: 'alt reply' });
    expect(branch.parentId).toBe(a.id);
    expect(s.getMessages().map(m => m.content)).toEqual(['one', 'alt reply']);

    // Original entries still exist in the file (preserved branch)
    const allEntries = s.getAllEntries().filter(e => e.type === 'message');
    expect(allEntries.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects setLeaf to an unknown id', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    expect(() => s.setLeaf('nonexistent')).toThrow();
  });

  it('label() bookmarks an entry; getLabelsOnPath() returns active-path labels only', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    const a = s.append({ type: 'message', role: 'user', content: 'one' });
    const b = s.append({ type: 'message', role: 'assistant', content: 'two' });
    s.label(a.id, 'good question');
    s.label(b.id, 'this answer was wrong');

    // Branch off `a` — the label on `b` is NO LONGER on the active path
    s.setLeaf(a.id);
    const c = s.append({ type: 'message', role: 'assistant', content: 'better' });
    s.label(c.id, 'this is right');

    const labels = s.getLabelsOnPath();
    expect(labels.has(a.id)).toBe(true);
    expect(labels.has(c.id)).toBe(true);
    expect(labels.has(b.id)).toBe(false);
  });

  it('fork() copies ancestry to a new file, leaf at the fork point', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    s.append({ type: 'message', role: 'user', content: 'one' });
    const b = s.append({ type: 'message', role: 'assistant', content: 'two' });
    s.append({ type: 'message', role: 'user', content: 'three' });

    const newPath = join(dir, 'fork.jsonl');
    const forked = s.fork(b.id, newPath);
    expect(forked.getLeafId()).toBe(b.id);
    const msgs = forked.getMessages();
    expect(msgs.map(m => m.content)).toEqual(['one', 'two']);
    // Original session is unchanged
    expect(s.getMessages().map(m => m.content)).toEqual(['one', 'two', 'three']);
  });

  it('clone() duplicates the active branch into a new file', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    s.append({ type: 'message', role: 'user', content: 'one' });
    s.append({ type: 'message', role: 'assistant', content: 'two' });

    const newPath = join(dir, 'clone.jsonl');
    const cloned = s.clone(newPath);
    expect(cloned.getMessages().map(m => m.content)).toEqual(['one', 'two']);
    // Cloned session is independent — appends don't affect the source
    cloned.append({ type: 'message', role: 'user', content: 'three' });
    expect(s.getMessages().map(m => m.content)).toEqual(['one', 'two']);
    expect(cloned.getMessages().map(m => m.content)).toEqual(['one', 'two', 'three']);
  });

  it('compaction summary replaces messages before firstKeptEntryId', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    s.append({ type: 'message', role: 'user', content: 'old 1' });
    s.append({ type: 'message', role: 'assistant', content: 'old 2' });
    const kept = s.append({ type: 'message', role: 'user', content: 'kept' });
    s.append({
      type: 'compaction',
      summary: 'discussed topic X',
      firstKeptEntryId: kept.id,
      tokensBefore: 4000,
    });
    s.append({ type: 'message', role: 'assistant', content: 'after compaction' });

    const msgs = s.getMessages();
    // Order: [system-summary, kept, after-compaction]
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('discussed topic X');
    expect(msgs[1].content).toBe('kept');
    expect(msgs[2].content).toBe('after compaction');
  });

  it('excludeFromContext flag keeps the entry in the file but out of getMessages()', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    s.append({ type: 'message', role: 'user', content: 'visible' });
    s.append({ type: 'message', role: 'system', content: 'hidden silent run', excludeFromContext: true });
    s.append({ type: 'message', role: 'assistant', content: 'reply' });

    const msgs = s.getMessages();
    expect(msgs.map(m => m.content)).toEqual(['visible', 'reply']);
    // But the entry exists in the file
    expect(s.getAllEntries().some(e => e.type === 'message' && e.content === 'hidden silent run')).toBe(true);
  });

  it('survives reopening with a custom leaf', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    const a = s.append({ type: 'message', role: 'user', content: 'one' });
    s.append({ type: 'message', role: 'assistant', content: 'two' });
    s.setLeaf(a.id);

    const reopened = JsonlSession.open(path);
    expect(reopened.getLeafId()).toBe(a.id);
    expect(reopened.getMessages().map(m => m.content)).toEqual(['one']);
  });

  it('leaf sidecar falls back to last entry if missing', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    s.append({ type: 'message', role: 'user', content: 'one' });
    const last = s.append({ type: 'message', role: 'assistant', content: 'two' });
    // Delete the sidecar
    rmSync(path.replace(/\.jsonl$/, '') + '.leaf');
    const reopened = JsonlSession.open(path);
    expect(reopened.getLeafId()).toBe(last.id);
  });

  it('updateMeta() chains and refreshes name/model/mode', () => {
    const s = JsonlSession.create(path, { name: 'orig', cwd: '/', model: 'a', mode: 'act' });
    s.updateMeta({ name: 'renamed', model: 'b', mode: 'plan' });
    const reopened = JsonlSession.open(path);
    expect(reopened.getMeta().name).toBe('renamed');
    expect(reopened.getMeta().model).toBe('b');
    expect(reopened.getMeta().mode).toBe('plan');
  });

  it('search() finds entries by predicate', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    s.append({ type: 'message', role: 'user', content: 'apple banana' });
    s.append({ type: 'message', role: 'assistant', content: 'cherry' });
    const matches = s.search(e => e.type === 'message' && (e as any).content.includes('banana'));
    expect(matches).toHaveLength(1);
  });

  it('rejects open on a missing file', () => {
    expect(() => JsonlSession.open(join(dir, 'nope.jsonl'))).toThrow();
  });

  it('rejects open on a file with no meta entry', () => {
    const corrupt = join(dir, 'corrupt.jsonl');
    writeFileSyncShim(corrupt, '{"type":"message","id":"x","parentId":null,"ts":1,"role":"user","content":"hi"}\n');
    expect(() => JsonlSession.open(corrupt)).toThrow();
  });

  it('skips corrupt lines on open', () => {
    const s = JsonlSession.create(path, { name: 't', cwd: '/', model: 'm', mode: 'act' });
    s.append({ type: 'message', role: 'user', content: 'good' });
    appendShim(path, 'NOT JSON\n');
    s.append({ type: 'message', role: 'assistant', content: 'still good' });
    const reopened = JsonlSession.open(path);
    expect(reopened.getMessages().map(m => m.content)).toEqual(['good', 'still good']);
  });
});

// Inline helpers — keep test deps minimal
import { writeFileSync as writeFileSyncShim, appendFileSync as appendShim } from 'fs';
