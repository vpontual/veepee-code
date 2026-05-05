import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTracker } from '../src/filetracker.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vcode-filetracker-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tmpFile(name: string, content = 'hello\n'): string {
  const p = join(tmpDir, name);
  writeFileSync(p, content);
  return p;
}

describe('FileTracker', () => {
  it('returns null for unread file when requireRead=false (write_file path)', () => {
    const tracker = new FileTracker();
    const p = tmpFile('a.txt');
    expect(tracker.checkFresh(p, false)).toBe(null);
  });

  it('refuses unread file when requireRead=true (edit_file path)', () => {
    const tracker = new FileTracker();
    const p = tmpFile('a.txt');
    const msg = tracker.checkFresh(p);
    expect(msg).not.toBe(null);
    expect(msg).toContain('was not read in this session');
  });

  it('allows non-existent file (creating new)', () => {
    const tracker = new FileTracker();
    const p = join(tmpDir, 'does-not-exist.txt');
    expect(tracker.checkFresh(p, true)).toBe(null);
    expect(tracker.checkFresh(p, false)).toBe(null);
  });

  it('allows edits after a recordRead with no on-disk change', () => {
    const tracker = new FileTracker();
    const p = tmpFile('a.txt');
    tracker.recordRead(p);
    expect(tracker.checkFresh(p)).toBe(null);
  });

  it('detects on-disk modification after the recorded read', () => {
    const tracker = new FileTracker();
    const p = tmpFile('a.txt');
    // Record read at "now", then bump mtime to the future.
    const before = Date.now();
    tracker.recordRead(p);
    const future = new Date(before + 60_000); // 1 minute in the future
    utimesSync(p, future, future);

    const msg = tracker.checkFresh(p);
    expect(msg).not.toBe(null);
    expect(msg).toContain('modified on disk after you last read it');
  });

  it('forget() removes a tracked path', () => {
    const tracker = new FileTracker();
    const p = tmpFile('a.txt');
    tracker.recordRead(p);
    expect(tracker.size()).toBe(1);
    tracker.forget(p);
    expect(tracker.size()).toBe(0);
    // After forget, the file is treated as never-read again
    expect(tracker.checkFresh(p)).toContain('was not read in this session');
  });

  it('paths() returns all tracked absolute paths', () => {
    const tracker = new FileTracker();
    const a = tmpFile('a.txt');
    const b = tmpFile('b.txt');
    tracker.recordRead(a);
    tracker.recordRead(b);
    expect(tracker.paths().sort()).toEqual([a, b].sort());
  });
});
