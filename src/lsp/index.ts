/**
 * LSP integration — barrel.
 *
 * Implements the design at `docs/plans/v0.4-lsp.md`. Phase A: minimal client
 * + diagnostics tool. Phases B/C/D ship later.
 */

export { LspClient } from './client.js';
export { LspManager, notifyLSPs } from './manager.js';
export type { LspServerConfig } from './config.js';
export { formatDiagnostic, formatDiagnostics } from './diagnostics.js';
export { pathToFileUri, fileUriToPath } from './uri.js';
