import { readFileSync, statSync } from 'node:fs';

/** How much of an unread file to inline with a freshness refusal. Enough to
 *  edit against; not enough to matter against the context window. */
const FRESHNESS_INLINE_MAX = 24_000;

/**
 * Tracks when files were last read in this session so edit_file / write_file
 * can refuse to overwrite a file that changed on disk after the model saw it.
 *
 * Single-process, in-memory only — no persistence across sessions.
 */
export class FileTracker {
  // path → max(mtime at read time, Date.now()). We track the larger of the two
  // so a subsequent stat with the same fractional mtime never appears "newer."
  private readAt = new Map<string, number>();

  recordRead(absPath: string): void {
    let mtime = 0;
    try {
      mtime = statSync(absPath).mtimeMs;
    } catch {
      // file doesn't exist (yet) — record "now" as a placeholder
    }
    this.readAt.set(absPath, Math.max(mtime, Date.now()));
  }

  /**
   * Returns null if the file is fresh (or doesn't exist yet), or an error
   * message if the model hasn't read it or it changed on disk since the last
   * read.
   *
   * @param absPath        absolute path to the file
   * @param requireRead    if true (default), refuse files never read in this
   *                       session. write_file passes false because creating a
   *                       new file is always fine.
   */
  checkFresh(absPath: string, requireRead = true): string | null {
    const last = this.readAt.get(absPath);
    let exists = true;
    let mtimeMs = 0;
    try {
      const stat = statSync(absPath);
      mtimeMs = stat.mtimeMs;
    } catch {
      exists = false;
    }

    // New file → always OK to create / write
    if (!exists) return null;

    if (last === undefined) {
      if (!requireRead) return null;
      // Refusing and saying "go read it" costs TWO turns: the failed edit and
      // the read that follows. Measured across five real-repo tasks: 12 of 262
      // tool calls went on that round trip, at ~33 seconds each. The file is
      // right here — hand it over with the refusal so the retry can succeed
      // immediately, and record the read so it does.
      let body: string;
      try {
        body = readFileSync(absPath, 'utf-8');
      } catch {
        return `File ${absPath} was not read in this session. Read it first with read_file before editing.`;
      }
      // Record it: the model has now SEEN the file, so the retry must not hit
      // this same gate. Forgetting this step would turn one wasted turn into
      // an infinite pair of them.
      this.recordRead(absPath);
      const shown = body.slice(0, FRESHNESS_INLINE_MAX);
      const clipped = shown.length < body.length ? `\n[... ${body.length - shown.length} more chars — read_file with an offset for the rest]` : '';
      return `File ${absPath} was not read in this session, so the edit was not applied. ` +
        `Its current contents are below — retry the edit against exactly this text.\n` +
        `<file path="${absPath}">\n${shown}${clipped}\n</file>`;
    }

    if (mtimeMs > last) {
      return `File ${absPath} was modified on disk after you last read it (mtime=${new Date(mtimeMs).toISOString()}, last read=${new Date(last).toISOString()}). Re-read it before editing.`;
    }

    return null;
  }

  forget(absPath: string): void {
    this.readAt.delete(absPath);
  }

  /** For tests / introspection. */
  size(): number {
    return this.readAt.size;
  }

  /** Returns the set of currently tracked absolute paths. */
  paths(): string[] {
    return [...this.readAt.keys()];
  }
}
