/**
 * LspManager — owns one LspClient per language label, lazy-starts on first
 * matching file. Picks the right client by file extension.
 *
 * One responsibility, deliberately narrow: file → client lookup, lifecycle,
 * and aggregation. Diagnostic *formatting* lives in diagnostics.ts; the
 * tool layer in src/tools/lsp.ts.
 */

import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { LspClient } from './client.js';
import {
  LSP_DEFAULT_DIAG_TIMEOUT_MS,
  type LspServerConfig,
} from './config.js';
import { pathToFileUri } from './uri.js';

/** Per-URI diagnostic snapshot used by formatDiagnostics. */
export interface DiagnosticsByUri {
  source: string;
  diagnostics: Diagnostic[];
}

interface ManagedClient {
  cfg: LspServerConfig;
  client: LspClient | null;
  /** Set when boot fails so we don't retry on every call. Cleared on /lsp restart. */
  failedReason: string | null;
}

export class LspManager {
  private rootUri: string;
  private servers: Map<string, ManagedClient>;

  constructor(servers: Record<string, LspServerConfig> | null, rootDir: string = process.cwd()) {
    this.rootUri = pathToFileUri(rootDir);
    this.servers = new Map();
    if (servers) {
      for (const [label, cfg] of Object.entries(servers)) {
        if (cfg.enabled === false) continue;
        this.servers.set(label, { cfg, client: null, failedReason: null });
      }
    }
  }

  /** Configured server labels (regardless of running state). */
  labels(): string[] {
    return [...this.servers.keys()];
  }

  /** Currently-running server labels. */
  runningLabels(): string[] {
    return [...this.servers.entries()]
      .filter(([, m]) => m.client?.isAlive())
      .map(([label]) => label);
  }

  /** Look up the configured server for a file by extension. Doesn't start it. */
  matchByPath(absPath: string): string | null {
    const ext = extname(absPath).replace(/^\./, '').toLowerCase();
    if (!ext) return null;
    for (const [label, m] of this.servers) {
      if (m.cfg.filetypes.map((s) => s.toLowerCase()).includes(ext)) return label;
    }
    return null;
  }

  /** Get (and lazily start) the matching client. Returns null if no server
   *  is configured for the file's extension, or if startup failed. */
  async getClientForFile(absPath: string): Promise<LspClient | null> {
    const label = this.matchByPath(absPath);
    if (!label) return null;
    return this.getClientByLabel(label);
  }

  /** Get (and lazily start) a client by its language label. */
  async getClientByLabel(label: string): Promise<LspClient | null> {
    const m = this.servers.get(label);
    if (!m) return null;
    if (m.client?.isAlive()) return m.client;
    if (m.failedReason) return null;
    if (!m.client) {
      try {
        m.client = await LspClient.start(label, m.cfg, this.rootUri);
      } catch (err) {
        m.failedReason = err instanceof Error ? err.message : String(err);
        return null;
      }
    } else if (!m.client.isAlive()) {
      // Crashed — try one auto-restart.
      try {
        m.client = await LspClient.start(label, m.cfg, this.rootUri);
        m.failedReason = null;
      } catch (err) {
        m.failedReason = err instanceof Error ? err.message : String(err);
        return null;
      }
    }
    return m.client;
  }

  /** Reason a label is unavailable (after a failed start or detected crash). */
  failureReason(label: string): string | null {
    return this.servers.get(label)?.failedReason ?? null;
  }

  /** Force-restart a server. Returns true on success. */
  async restart(label: string): Promise<boolean> {
    const m = this.servers.get(label);
    if (!m) return false;
    if (m.client) {
      try { await m.client.shutdown(); } catch { /* swallow */ }
    }
    m.client = null;
    m.failedReason = null;
    const c = await this.getClientByLabel(label);
    return !!c;
  }

  /** Aggregate snapshot across all running clients. URI → {source, diags}. */
  getAllDiagnostics(): Map<string, DiagnosticsByUri> {
    const out = new Map<string, DiagnosticsByUri>();
    for (const [label, m] of this.servers) {
      const c = m.client;
      if (!c?.isAlive()) continue;
      for (const [uri, diags] of c.allDiagnostics()) {
        if (diags.length === 0) continue;
        out.set(uri, { source: label, diagnostics: diags });
      }
    }
    return out;
  }

  /** Pre-warm any servers that have warmOnStart=true. Best-effort and
   *  parallel; failures are recorded but don't reject the overall promise. */
  async warmStart(): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const [label, m] of this.servers) {
      if (m.cfg.warmOnStart) tasks.push(this.getClientByLabel(label));
    }
    await Promise.allSettled(tasks);
  }

  /** Shutdown everything. Always resolves; never throws. */
  async shutdown(): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const m of this.servers.values()) {
      if (m.client) tasks.push(m.client.shutdown().catch(() => undefined));
    }
    await Promise.allSettled(tasks);
    this.servers.clear();
  }
}

/**
 * Open `filePath` in the matching LSP client (if any), send the file's
 * current contents, and wait up to the client's configured timeout for
 * publishDiagnostics. Best-effort — never throws; never blocks long.
 *
 * The diagnostics live on the client after this returns; callers read
 * them via `manager.getAllDiagnostics()` or `client.diagnosticsFor(uri)`.
 */
export async function notifyLSPs(manager: LspManager, filePath: string): Promise<void> {
  let client: LspClient | null;
  try {
    client = await manager.getClientForFile(filePath);
  } catch {
    return;
  }
  if (!client) return;

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return;
  }

  const uri = pathToFileUri(filePath);
  try {
    await client.openFile(uri, client.label, content);
    // openFile internally translates to didChange when the doc is already
    // known. Either way, the next publishDiagnostics carries the version
    // we just sent.
    await client.waitForDiagnostics(uri, LSP_DEFAULT_DIAG_TIMEOUT_MS);
  } catch {
    // Server died mid-call or returned an error — the diagnostics map
    // still has whatever's there. Don't propagate.
  }
}
