import { mkdir, readdir, stat, rename, cp, rm } from 'fs/promises';
import { resolve, join, basename, relative, isAbsolute } from 'path';
import { existsSync } from 'fs';

function getSandboxRoot(): string {
  return resolve(process.env.HOME || '~', '.veepee-code', 'sandbox');
}

export interface SandboxFileInfo {
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
}

export class SandboxManager {
  private sessionId: string;
  private root: string;
  private dir: string;
  private created = false;

  constructor(sessionId: string, rootDir?: string) {
    this.sessionId = sessionId;
    this.root = rootDir || getSandboxRoot();
    this.dir = join(this.root, sessionId);
  }

  /** Lazy-create and return the sandbox directory path */
  async getPath(): Promise<string> {
    if (!this.created) {
      await mkdir(this.dir, { recursive: true });
      this.created = true;
    }
    return this.dir;
  }

  /** Get the sandbox path synchronously (for system prompt injection) */
  getPathSync(): string {
    return this.dir;
  }

  /** List all files in the sandbox with sizes */
  async list(): Promise<SandboxFileInfo[]> {
    if (!existsSync(this.dir)) return [];

    const entries = await readdir(this.dir);
    const files: SandboxFileInfo[] = [];

    for (const name of entries) {
      const filePath = join(this.dir, name);
      try {
        const s = await stat(filePath);
        if (s.isFile()) {
          files.push({
            name,
            path: filePath,
            size: s.size,
            modifiedAt: s.mtime,
          });
        }
      } catch { /* skip unreadable */ }
    }

    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Move a file out of sandbox to a real location */
  async keep(file: string, destination?: string): Promise<string> {
    const srcPath = this.resolveSandboxPath(file);
    if (!existsSync(srcPath)) {
      throw new Error(`File not found in sandbox: ${file}`);
    }

    const destPath = destination
      ? resolve(process.cwd(), destination)
      : resolve(process.cwd(), basename(file));

    // rename() clobbers silently. The destination is user-supplied, so the
    // only safe default is to refuse and let them name a different target.
    if (existsSync(destPath)) {
      throw new Error(
        `Refusing to overwrite existing file: ${destPath}\n` +
        `Pass a different destination, or remove the file first.`,
      );
    }

    try {
      // Try rename first (same filesystem = instant)
      await rename(srcPath, destPath);
    } catch {
      // Cross-filesystem: copy + delete
      await cp(srcPath, destPath);
      await rm(srcPath);
    }

    return destPath;
  }

  /** Remove the entire session sandbox directory */
  async clean(): Promise<void> {
    if (existsSync(this.dir)) {
      await rm(this.dir, { recursive: true, force: true });
    }
    this.created = false;
  }

  /** Check if sandbox has any files */
  async hasFiles(): Promise<boolean> {
    if (!existsSync(this.dir)) return false;
    const entries = await readdir(this.dir);
    return entries.length > 0;
  }

  /** Remove sandbox directories untouched for 24 hours (call on startup).
   *
   *  `skipSessionId` protects the live session unconditionally. */
  static async cleanupStale(rootDir?: string, skipSessionId?: string): Promise<number> {
    const sandboxRoot = rootDir || getSandboxRoot();
    if (!existsSync(sandboxRoot)) return 0;

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let cleaned = 0;

    try {
      const dirs = await readdir(sandboxRoot);
      for (const dir of dirs) {
        if (skipSessionId && dir === skipSessionId) continue;
        const dirPath = join(sandboxRoot, dir);
        try {
          const s = await stat(dirPath);
          if (!s.isDirectory()) continue;
          if (await SandboxManager.lastTouchedMs(dirPath, s.mtimeMs) >= cutoff) continue;
          await rm(dirPath, { recursive: true, force: true });
          cleaned++;
        } catch { /* skip */ }
      }
    } catch { /* sandbox root doesn't exist yet */ }

    return cleaned;
  }

  /** Newest mtime across a directory and its entries.
   *
   *  A directory's own mtime only changes when entries are added or removed —
   *  not when a file inside it is written. Keying staleness on the directory
   *  alone deleted the sandbox of a long-running session that kept rewriting
   *  the same files. */
  private static async lastTouchedMs(dirPath: string, dirMtimeMs: number): Promise<number> {
    let newest = dirMtimeMs;
    try {
      for (const entry of await readdir(dirPath)) {
        try {
          const es = await stat(join(dirPath, entry));
          if (es.mtimeMs > newest) newest = es.mtimeMs;
        } catch { /* unreadable entry — ignore */ }
      }
    } catch { /* unreadable dir — fall back to its own mtime */ }
    return newest;
  }

  /** Resolve a path that may be sandbox-relative (sandbox:filename) */
  resolvePath(input: string): string {
    if (input.startsWith('sandbox:')) {
      return this.resolveSandboxPath(input.slice(8));
    }
    return resolve(process.cwd(), input);
  }

  private resolveSandboxPath(file: string): string {
    const resolved = resolve(this.dir, file);
    const rel = relative(this.dir, resolved);
    const inSandbox = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    if (!inSandbox) {
      throw new Error(`Sandbox path escapes sandbox root: ${file}`);
    }
    return resolved;
  }
}

/** Format file size for display */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
