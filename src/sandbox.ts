import { mkdir, readdir, stat, rename, cp, rm } from 'fs/promises';
import { resolve, join, basename } from 'path';
import { existsSync } from 'fs';

const SANDBOX_ROOT = resolve(process.env.HOME || '~', '.veepee-code', 'sandbox');

export interface SandboxFileInfo {
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
}

export class SandboxManager {
  private sessionId: string;
  private dir: string;
  private created = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.dir = join(SANDBOX_ROOT, sessionId);
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
    const srcPath = join(this.dir, file);
    if (!existsSync(srcPath)) {
      throw new Error(`File not found in sandbox: ${file}`);
    }

    const destPath = destination
      ? resolve(process.cwd(), destination)
      : resolve(process.cwd(), basename(file));

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

  /** Remove sandbox directories older than 24 hours (call on startup) */
  static async cleanupStale(): Promise<number> {
    if (!existsSync(SANDBOX_ROOT)) return 0;

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let cleaned = 0;

    try {
      const dirs = await readdir(SANDBOX_ROOT);
      for (const dir of dirs) {
        const dirPath = join(SANDBOX_ROOT, dir);
        try {
          const s = await stat(dirPath);
          if (s.isDirectory() && s.mtimeMs < cutoff) {
            await rm(dirPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch { /* skip */ }
      }
    } catch { /* sandbox root doesn't exist yet */ }

    return cleaned;
  }

  /** Resolve a path that may be sandbox-relative (sandbox:filename) */
  resolvePath(input: string): string {
    if (input.startsWith('sandbox:')) {
      return join(this.dir, input.slice(8));
    }
    return resolve(process.cwd(), input);
  }
}

/** Format file size for display */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
