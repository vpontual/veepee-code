import { statSync } from 'node:fs';

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
      return `File ${absPath} was not read in this session. Read it first with read_file before editing.`;
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
