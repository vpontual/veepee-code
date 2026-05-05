/**
 * LSP-backed tools. Phase A: lsp_diagnostics + lsp_restart.
 *
 * Phase B (later) wires notifyLSPs into edit_file/write_file/multi_edit;
 * Phase C adds lsp_references + lsp_definition.
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import { ok, fail } from './types.js';
import type { ToolDef } from './types.js';
import type { LspManager } from '../lsp/manager.js';
import { notifyLSPs } from '../lsp/manager.js';
import { formatDiagnostics } from '../lsp/diagnostics.js';

export function registerLspTools(manager: LspManager): ToolDef[] {
  return [
    createLspDiagnosticsTool(manager),
    createLspRestartTool(manager),
  ];
}

function createLspDiagnosticsTool(manager: LspManager): ToolDef {
  return {
    name: 'lsp_diagnostics',
    description: [
      'Get LSP diagnostics (errors, warnings, info) for a file or the whole project.',
      'Use this after editing to see compile/type errors immediately.',
      'When a path is given, the file is opened or refreshed in the matching language server before reading diagnostics.',
      'Returns a structured block: <file_diagnostics>, <project_diagnostics>, <diagnostic_summary>. Each section caps at 10 entries.',
    ].join(' '),
    schema: z.object({
      path: z.string().optional().describe('Absolute or relative file path. Omit for a project-wide snapshot.'),
    }),
    execute: async (params) => {
      const rawPath = params.path as string | undefined;
      const filePath = rawPath ? resolve(rawPath) : undefined;

      if (filePath) {
        const matchedLabel = manager.matchByPath(filePath);
        if (!matchedLabel) {
          return ok(`No LSP server is configured for ${filePath}. Configure one under "lsp" in settings.json (see docs/plans/v0.4-lsp.md).`);
        }
        await notifyLSPs(manager, filePath);
      }

      const all = manager.getAllDiagnostics();
      const block = formatDiagnostics(all, filePath);
      if (!block) {
        return ok(filePath
          ? `No diagnostics for ${filePath} or the rest of the project.`
          : 'No diagnostics across all open files.');
      }
      return ok(block);
    },
  };
}

function createLspRestartTool(manager: LspManager): ToolDef {
  return {
    name: 'lsp_restart',
    description: 'Restart an LSP server by language label. Use when diagnostics seem stale, the server appears stuck, or after installing a new server binary.',
    schema: z.object({
      language: z.string().describe('Language label from the lsp config block (e.g. "typescript", "go").'),
    }),
    execute: async (params) => {
      const language = String(params.language ?? '').trim();
      if (!language) return fail('lsp_restart requires a language label.');
      if (!manager.labels().includes(language)) {
        return fail(`No LSP server configured for label "${language}". Configured: [${manager.labels().join(', ')}].`);
      }
      const ok_ = await manager.restart(language);
      if (!ok_) {
        const reason = manager.failureReason(language);
        return fail(`Failed to restart "${language}"${reason ? `: ${reason}` : ''}.`);
      }
      return ok(`Restarted LSP server "${language}".`);
    },
  };
}
