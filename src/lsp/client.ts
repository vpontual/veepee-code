/**
 * LspClient — one subprocess + one vscode-jsonrpc connection per language.
 *
 * Lifecycle:
 *   start() → spawn server, initialize handshake, mark alive
 *   openFile / notifyChange / waitForDiagnostics — request loop
 *   shutdown() → LSP shutdown → exit → SIGTERM → SIGKILL
 *
 * State:
 *   diagnostics: Map<uri, Diagnostic[]>  — kept fresh by publishDiagnostics handler
 *   docVersions: Map<uri, number>        — version counter for didChange
 *   pendingDiagWaiters: Map<uri, Waiter[]> — promises parked by waitForDiagnostics
 *
 * The version-gated waiter handles the trap where the server has already
 * sent diagnostics before waitForDiagnostics is called — when a notification
 * arrives, we resolve every waiter whose expected version ≤ the
 * notification's "the file was at this version" snapshot.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node.js';
import {
  InitializeRequest, InitializedNotification,
  DidOpenTextDocumentNotification, DidChangeTextDocumentNotification,
  PublishDiagnosticsNotification, ShutdownRequest, ExitNotification,
  ReferencesRequest, DefinitionRequest,
  type Diagnostic, type Location, type ServerCapabilities,
} from 'vscode-languageserver-protocol';
import {
  LSP_DEFAULT_INIT_TIMEOUT_MS,
  LSP_DEFAULT_DIAG_TIMEOUT_MS,
  type LspServerConfig,
} from './config.js';
import { pathToFileUri } from './uri.js';

interface PendingWaiter {
  expectedVersion: number;
  resolve: (diags: Diagnostic[]) => void;
}

/** File extension to LSP languageId. Servers key parsing behaviour off this,
 *  so `.tsx` must be `typescriptreact`, not `typescript`. Anything unlisted
 *  falls back to the server's own label. */
const LANGUAGE_IDS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact',
  js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  go: 'go', rs: 'rust', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', lua: 'lua', sh: 'shellscript', bash: 'shellscript',
  json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  md: 'markdown', html: 'html', css: 'css', scss: 'scss', sql: 'sql',
};

export class LspClient {
  /** Language label this client serves — appears in diagnostic output. */
  readonly label: string;
  private cfg: LspServerConfig;
  private rootUri: string;
  private proc: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private alive = false;
  /** Reason the server is no longer usable. Cleared on each successful start. */
  private deadReason: string | null = null;

  private diagnostics = new Map<string, Diagnostic[]>();
  private docVersions = new Map<string, number>();
  /** Highest document version the server has published diagnostics for, per
   *  URI. Lets waitForDiagnostics answer immediately when the notification
   *  already arrived instead of parking for one that will never come. */
  private lastDiagVersion = new Map<string, number>();
  private openDocs = new Set<string>();
  private pendingDiagWaiters = new Map<string, PendingWaiter[]>();
  private serverCapabilities: ServerCapabilities | null = null;

  private constructor(label: string, cfg: LspServerConfig, rootUri: string) {
    this.label = label;
    this.cfg = cfg;
    this.rootUri = rootUri;
  }

  static async start(label: string, cfg: LspServerConfig, rootUri: string): Promise<LspClient> {
    const client = new LspClient(label, cfg, rootUri);
    await client.boot();
    return client;
  }

  private async boot(): Promise<void> {
    const env = { ...process.env, ...(this.cfg.env ?? {}) };
    // `detached` makes the server its own process-group leader so shutdown can
    // signal the whole tree. Language servers fan out: typescript-language-server
    // runs two tsserver children, and a signal aimed at the wrapper alone leaves
    // them orphaned. Closing our pipes still gives the server EOF if vcode dies
    // abruptly, so the usual safety net is unaffected.
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env,
    });
    this.proc = proc;

    // Capture spawn errors (ENOENT, EACCES) so they surface as clean
    // rejections from start() instead of unhandled-error events.
    const spawnErrorRef: { err: Error | null } = { err: null };
    proc.on('error', (err) => { spawnErrorRef.err = err; });

    // Surface stderr to vcode's stderr so server crashes/log lines aren't
    // swallowed silently. They'll appear above the TUI on next render.
    proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[lsp:${this.label}] ${chunk.toString()}`);
    });

    proc.on('exit', (code, signal) => {
      this.alive = false;
      this.deadReason = `server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      // Resolve any pending waiters with whatever diagnostics we have so
      // callers don't hang forever on a dead server.
      this.flushAllWaiters();
      this.connection?.dispose();
      this.connection = null;
    });

    if (!proc.stdout || !proc.stdin) {
      throw new Error(`lsp:${this.label}: server failed to spawn (no stdio)`);
    }

    // Give the kernel a tick to deliver an immediate ENOENT before we send
    // anything down the pipe — saves us from "write after stream destroyed".
    await new Promise((resolve) => setImmediate(resolve));
    if (spawnErrorRef.err) {
      throw new Error(`lsp:${this.label}: failed to spawn '${this.cfg.command}' — ${spawnErrorRef.err.message}`);
    }
    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    );
    this.connection = conn;

    // Some servers (gopls, pyright) request workspace/configuration during
    // initialization. We don't have any project-specific overrides yet, so
    // respond with an array of nulls matching the request's items count —
    // that's the LSP spec's "no configuration available" answer.
    conn.onRequest('workspace/configuration', (params: { items: unknown[] }) => {
      return params.items.map(() => null);
    });

    // Many servers send window/workDoneProgress/create requests; ack them.
    conn.onRequest('window/workDoneProgress/create', () => null);
    conn.onRequest('client/registerCapability', () => null);
    conn.onRequest('client/unregisterCapability', () => null);

    conn.onNotification(PublishDiagnosticsNotification.type, (params) => {
      this.diagnostics.set(params.uri, params.diagnostics);
      // version may be undefined per LSP spec; use the doc's current version
      // as the gate when missing.
      const version = params.version ?? this.docVersions.get(params.uri) ?? 0;
      this.lastDiagVersion.set(params.uri, version);
      this.flushWaiters(params.uri, version);
    });

    conn.listen();

    // Initialize handshake with timeout.
    const initTimeout = this.cfg.initTimeoutMs ?? LSP_DEFAULT_INIT_TIMEOUT_MS;
    const initResult = await Promise.race([
      conn.sendRequest(InitializeRequest.type, {
        processId: process.pid,
        clientInfo: { name: 'veepee-code', version: '0.3.0' },
        rootUri: this.rootUri,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        capabilities: ({
          textDocument: {
            synchronization: { didSave: true, willSave: false, willSaveWaitUntil: false, dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true, versionSupport: true },
            references: { dynamicRegistration: false },
            definition: { dynamicRegistration: false, linkSupport: false },
          },
          workspace: {
            configuration: true,
            workspaceFolders: true,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
        workspaceFolders: [{ uri: this.rootUri, name: this.label }],
        initializationOptions: {},
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`lsp:${this.label}: initialize timed out after ${initTimeout}ms`)), initTimeout),
      ),
    ]);
    this.serverCapabilities = initResult.capabilities ?? null;

    await conn.sendNotification(InitializedNotification.type, {});

    this.alive = true;
    this.deadReason = null;
  }

  isAlive(): boolean {
    return this.alive;
  }

  deadMessage(): string | null {
    return this.deadReason;
  }

  capabilities(): ServerCapabilities | null {
    return this.serverCapabilities;
  }

  private requireAlive(): MessageConnection {
    if (!this.alive || !this.connection) {
      throw new Error(`lsp:${this.label} is not alive: ${this.deadReason ?? 'never started'}`);
    }
    return this.connection;
  }

  /** Open a file in the server. Idempotent — safe to call repeatedly; subsequent
   *  calls are translated to didChange. */
  async openFile(uri: string, languageId: string, content: string): Promise<void> {
    const conn = this.requireAlive();
    if (this.openDocs.has(uri)) {
      // Already open — translate to didChange instead.
      return this.notifyChange(uri, content);
    }
    const version = 1;
    this.docVersions.set(uri, version);
    this.openDocs.add(uri);
    await conn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId, version, text: content },
    });
  }

  /** Send didChange. Bumps the version counter so waitForDiagnostics knows
   *  which notification corresponds to this content. */
  async notifyChange(uri: string, content: string): Promise<void> {
    const conn = this.requireAlive();
    if (!this.openDocs.has(uri)) {
      // Server doesn't know about this file yet — fall back to didOpen so
      // we don't drop the diagnostic.
      return this.openFile(uri, this.languageIdFor(uri), content);
    }
    const version = (this.docVersions.get(uri) ?? 0) + 1;
    this.docVersions.set(uri, version);
    await conn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  /**
   * URIs whose last `waitForDiagnostics` gave up waiting.
   *
   * Lazily created rather than a field initializer: the lifecycle tests build
   * partial clients without running the constructor, and a method that assumes
   * its own fields exist turns those into TypeErrors.
   */
  private timedOutWaits?: Set<string>;

  /** Did the most recent wait for this uri time out rather than being answered? */
  diagnosticsTimedOut(uri: string): boolean {
    return this.timedOutWaits?.has(uri) ?? false;
  }

  /**
   * Wait up to `timeoutMs` for the server to publish diagnostics for `uri`
   * matching the latest version we've sent. Resolves with whatever the
   * server has (possibly empty) on timeout — and RECORDS that it timed out,
   * because "no diagnostics yet" and "no diagnostics" are the same value and
   * opposite facts. Reported as clean, the first one tells the model its broken
   * edit compiled.
   */
  async waitForDiagnostics(uri: string, timeoutMs?: number): Promise<Diagnostic[]> {
    const tmo = timeoutMs ?? this.cfg.diagnosticsTimeoutMs ?? LSP_DEFAULT_DIAG_TIMEOUT_MS;
    if (!this.alive) return this.diagnostics.get(uri) ?? [];

    const expectedVersion = this.docVersions.get(uri) ?? 0;

    // Already answered. Without this the waiter parks for a notification that
    // has been and gone, and burns the entire timeout before returning the
    // very diagnostics it is holding — the class comment claims the version
    // gate covers this case, and this is what actually makes that true.
    if ((this.lastDiagVersion.get(uri) ?? -1) >= expectedVersion) {
      this.timedOutWaits?.delete(uri);
      return this.diagnostics.get(uri) ?? [];
    }
    this.timedOutWaits?.delete(uri);

    return new Promise<Diagnostic[]>((resolve) => {
      const waiter: PendingWaiter = {
        expectedVersion,
        resolve: (diags) => resolve(diags),
      };
      const list = this.pendingDiagWaiters.get(uri) ?? [];
      list.push(waiter);
      this.pendingDiagWaiters.set(uri, list);

      const t = setTimeout(() => {
        (this.timedOutWaits ??= new Set()).add(uri);
        // Remove this waiter and resolve with whatever we have.
        const arr = this.pendingDiagWaiters.get(uri);
        if (arr) {
          const idx = arr.indexOf(waiter);
          if (idx >= 0) arr.splice(idx, 1);
        }
        resolve(this.diagnostics.get(uri) ?? []);
      }, tmo);

      // Tag the timeout onto the waiter so flushWaiters can clear it.
      (waiter as PendingWaiter & { _t?: NodeJS.Timeout })._t = t;
    });
  }

  private flushWaiters(uri: string, atOrAboveVersion: number): void {
    const list = this.pendingDiagWaiters.get(uri);
    if (!list || list.length === 0) return;
    const remaining: PendingWaiter[] = [];
    const diags = this.diagnostics.get(uri) ?? [];
    for (const waiter of list) {
      if (atOrAboveVersion >= waiter.expectedVersion) {
        const t = (waiter as PendingWaiter & { _t?: NodeJS.Timeout })._t;
        if (t) clearTimeout(t);
        waiter.resolve(diags);
      } else {
        remaining.push(waiter);
      }
    }
    if (remaining.length === 0) this.pendingDiagWaiters.delete(uri);
    else this.pendingDiagWaiters.set(uri, remaining);
  }

  private flushAllWaiters(): void {
    for (const [uri, list] of this.pendingDiagWaiters) {
      const diags = this.diagnostics.get(uri) ?? [];
      for (const waiter of list) {
        const t = (waiter as PendingWaiter & { _t?: NodeJS.Timeout })._t;
        if (t) clearTimeout(t);
        waiter.resolve(diags);
      }
    }
    this.pendingDiagWaiters.clear();
  }

  /** Get diagnostics for one URI without waiting. */
  diagnosticsFor(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  /** Snapshot of all diagnostics this client knows about. */
  allDiagnostics(): Map<string, Diagnostic[]> {
    return new Map(this.diagnostics);
  }

  /** LSP textDocument/references. */
  async getReferences(uri: string, line: number, character: number, includeDeclaration = true): Promise<Location[]> {
    const conn = this.requireAlive();
    const result = await conn.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    });
    return result ?? [];
  }

  /** LSP textDocument/definition. Returns array of locations. */
  async getDefinition(uri: string, line: number, character: number): Promise<Location[]> {
    const conn = this.requireAlive();
    const result = await conn.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: { line, character },
    });
    if (!result) return [];
    return Array.isArray(result) ? result as Location[] : [result as Location];
  }

  /** LSP languageId for a URI, by extension.
   *
   *  Both branches of this used to return `this.label`, so every file opened
   *  under the server's label — a `.tsx` file was announced as `typescript`
   *  rather than `typescriptreact`, which changes how servers parse it. */
  languageIdFor(uri: string): string {
    const ext = uri.split('.').pop()?.toLowerCase() ?? '';
    return LANGUAGE_IDS[ext] ?? this.label;
  }

  /**
   * Clean shutdown: LSP shutdown request → exit notification → wait → SIGTERM → SIGKILL.
   * Always resolves; never throws. Idempotent.
   */
  async shutdown(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    const conn = this.connection;
    this.connection = null;
    this.alive = false;
    this.deadReason = 'shutdown requested';

    if (conn) {
      try {
        // Send LSP shutdown + exit. Don't wait too long.
        await Promise.race([
          (async () => {
            await conn.sendRequest(ShutdownRequest.type);
            await conn.sendNotification(ExitNotification.type);
          })(),
          new Promise((res) => setTimeout(res, 1000)),
        ]);
      } catch {
        // Server might already be gone — that's fine.
      }
      try { conn.dispose(); } catch { /* swallow */ }
    }

    // Wait up to 2s for natural exit, then SIGTERM, then SIGKILL — each aimed
    // at the process GROUP, so the server's own children go with it.
    if (proc.exitCode !== null) return;
    const signalTree = (signal: NodeJS.Signals) => {
      try {
        if (proc.pid !== undefined) process.kill(-proc.pid, signal);
      } catch {
        // Group already gone; fall back to the direct child just in case.
        try { proc.kill(signal); } catch { /* swallow */ }
      }
    };
    await new Promise<void>((resolve) => {
      const onExit = () => { cleanup(); resolve(); };
      const cleanup = () => {
        proc.off('exit', onExit);
        clearTimeout(termTimer);
        clearTimeout(killTimer);
      };
      proc.on('exit', onExit);
      const termTimer = setTimeout(() => signalTree('SIGTERM'), 2000);
      const killTimer = setTimeout(() => { signalTree('SIGKILL'); cleanup(); resolve(); }, 3000);
    });

    this.flushAllWaiters();
  }
}
