/**
 * Custom statusline support.
 *
 * Runs `~/.veepee-code/statusline.sh` (or any executable; path is
 * configurable but we default to that location) with vcode state piped to
 * stdin as JSON, captures stdout, and exposes it for the TUI's right-aligned
 * statusline area. Falls back to the built-in minimalist display when the
 * script is absent or fails.
 *
 * Cached for STATUSLINE_TTL_MS to avoid spawning per-render. The TUI calls
 * `getStatusline(state)` on every render; the cache returns immediately
 * (sub-microsecond) until TTL expires, then a background refresh runs.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getConfigDir } from './config.js';

export interface StatuslineState {
  model: string;
  modelSize?: string;
  mode: 'act' | 'plan' | 'chat';
  tokens: number;
  tokenPercent: number;
  cwd: string;
  sessionId?: string | null;
  apiPort: number;
  apiConnected: boolean;
  version: string;
}

const STATUSLINE_TTL_MS = 30_000;
const STATUSLINE_TIMEOUT_MS = 5_000;

interface CacheEntry {
  output: string | null;
  fetchedAt: number;
  refreshing: boolean;
}

let cache: CacheEntry | null = null;
let scriptPath: string | null = null;

export function getStatuslinePath(): string {
  return scriptPath ?? resolve(getConfigDir(), 'statusline.sh');
}

export function setStatuslinePath(p: string | null): void {
  scriptPath = p;
  cache = null; // invalidate
}

/** Returns the cached statusline string, or null if no script or last run
 *  failed. Triggers a background refresh when stale; never blocks. */
export function getStatusline(state: StatuslineState): string | null {
  const path = getStatuslinePath();
  const now = Date.now();

  // Cache hit (fresh)
  if (cache && now - cache.fetchedAt < STATUSLINE_TTL_MS) {
    return cache.output;
  }

  // Stale or absent — kick off a refresh, return last known value (may be null).
  if (!cache?.refreshing) {
    void refreshStatusline(path, state);
  }
  return cache?.output ?? null;
}

async function refreshStatusline(path: string, state: StatuslineState): Promise<void> {
  if (!existsSync(path)) {
    cache = { output: null, fetchedAt: Date.now(), refreshing: false };
    return;
  }
  if (cache) cache.refreshing = true;
  else cache = { output: null, fetchedAt: 0, refreshing: true };

  try {
    const out = await runScript(path, state);
    cache = { output: out, fetchedAt: Date.now(), refreshing: false };
  } catch {
    // Failed run — cache the failure for the TTL so we don't retry every render.
    cache = { output: null, fetchedAt: Date.now(), refreshing: false };
  }
}

function runScript(path: string, state: StatuslineState): Promise<string | null> {
  return new Promise((resolveP) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn('bash', [path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, VEEPEE_STATUSLINE: '1' },
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolveP(null);
    }, STATUSLINE_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // Surface stderr on failure so users can debug. One-time per refresh.
        if (stderr.trim()) {
          process.stderr.write(`[statusline] exit ${code}: ${stderr.trim().slice(0, 200)}\n`);
        }
        resolveP(null);
      } else {
        // Trim, take first line — statusline is one row.
        const firstLine = stdout.split('\n')[0]?.trim() ?? '';
        resolveP(firstLine.length > 0 ? firstLine : null);
      }
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolveP(null);
    });

    try {
      proc.stdin.write(JSON.stringify(state));
      proc.stdin.end();
    } catch { /* already closed */ }
  });
}

/** For tests + setup wizard — force a refresh now and return the result. */
export async function refreshNow(state: StatuslineState): Promise<string | null> {
  const path = getStatuslinePath();
  await refreshStatusline(path, state);
  return cache?.output ?? null;
}
