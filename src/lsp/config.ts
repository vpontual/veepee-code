/**
 * LSP server configuration. Mirrors the design at docs/plans/v0.4-lsp.md
 * § Config schema. The discriminator is the language label (Record key);
 * the value is everything needed to spawn and talk to one server.
 */

export interface LspServerConfig {
  /** Executable on PATH or absolute path. e.g. "typescript-language-server". */
  command: string;
  /** Args passed to the executable. e.g. ["--stdio"]. */
  args?: string[];
  /** File extensions (without the dot) this server handles. */
  filetypes: string[];
  /** Extra env. Merged onto process.env at spawn time. */
  env?: Record<string, string>;
  /** Marker files used to find the project root. e.g. ["tsconfig.json"]. */
  rootPatterns?: string[];
  /** Fail server start if no `initialize` response in this many ms. */
  initTimeoutMs?: number;
  /** Wait this long after didChange for `publishDiagnostics`. */
  diagnosticsTimeoutMs?: number;
  /** When false, this server is configured but never started. */
  enabled?: boolean;
  /** When true, init the server when the session opens (default false). */
  warmOnStart?: boolean;
}

export const LSP_DEFAULT_INIT_TIMEOUT_MS = 15_000;
export const LSP_DEFAULT_DIAG_TIMEOUT_MS = 5_000;
