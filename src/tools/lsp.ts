/**
 * LSP-backed tools.
 *   Phase A: lsp_diagnostics, lsp_restart.
 *   Phase B (in src/tools/coding.ts): inline diagnostics in edit results.
 *   Phase C: lsp_references, lsp_definition.
 *   Phase D (in src/tools/coding.ts): non-blocking open in read_file.
 */

import { z } from 'zod';
import { resolve, relative } from 'node:path';
import { ok, fail } from './types.js';
import type { ToolDef } from './types.js';
import type { LspManager } from '../lsp/manager.js';
import { notifyLSPs } from '../lsp/manager.js';
import { formatDiagnostics } from '../lsp/diagnostics.js';
import { pathToFileUri, fileUriToPath } from '../lsp/uri.js';
import type { Location } from 'vscode-languageserver-protocol';

export function registerLspTools(manager: LspManager): ToolDef[] {
  return [
    createLspDiagnosticsTool(manager),
    createLspRestartTool(manager),
    createLspReferencesTool(manager),
    createLspDefinitionTool(manager),
  ];
}

const LOCATION_CAP = 50;

function formatLocations(locations: Location[], cwd: string): string {
  if (locations.length === 0) return 'No matches.';
  const lines: string[] = [];
  for (const loc of locations.slice(0, LOCATION_CAP)) {
    let p: string;
    try { p = fileUriToPath(loc.uri); } catch { continue; }
    const rel = relative(cwd, p) || p;
    const line = loc.range.start.line + 1;
    const col = loc.range.start.character + 1;
    lines.push(`${rel}:${line}:${col}`);
  }
  if (locations.length > LOCATION_CAP) {
    lines.push(`... and ${locations.length - LOCATION_CAP} more locations`);
  }
  return lines.join('\n');
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

function createLspReferencesTool(manager: LspManager): ToolDef {
  return {
    name: 'lsp_references',
    description: [
      'Find all references to the symbol at a specific file:line:character via LSP.',
      'More accurate than grep for renames or symbol-aware refactors — the server resolves cross-file imports and respects scope.',
      'Returns up to 50 locations as `path:line:col`.',
    ].join(' '),
    schema: z.object({
      path: z.string().describe('Absolute or relative file path'),
      line: z.number().int().min(1).describe('1-based line number'),
      character: z.number().int().min(0).describe('0-based character offset on the line'),
      include_declaration: z.boolean().optional().default(true).describe('Include the declaration site itself in the results'),
    }),
    execute: async (params) => {
      const filePath = resolve(params.path as string);
      const line1 = params.line as number;
      const character = params.character as number;
      const includeDecl = params.include_declaration as boolean;
      const client = await manager.getClientForFile(filePath);
      if (!client) {
        return fail(`No running LSP server for ${filePath}. Configure one under "lsp" in settings.json.`);
      }
      // Make sure the server has read the file before asking for references.
      await notifyLSPs(manager, filePath);
      try {
        const locations = await client.getReferences(pathToFileUri(filePath), line1 - 1, character, includeDecl);
        if (!locations || locations.length === 0) {
          return ok(`No references found for ${relative(process.cwd(), filePath)}:${line1}:${character + 1}.`);
        }
        return ok(`${locations.length} reference${locations.length === 1 ? '' : 's'}:\n${formatLocations(locations, process.cwd())}`);
      } catch (err) {
        return fail(`lsp_references failed: ${(err as Error).message}`);
      }
    },
  };
}

function createLspDefinitionTool(manager: LspManager): ToolDef {
  return {
    name: 'lsp_definition',
    description: [
      'Find the definition site of the symbol at a specific file:line:character via LSP.',
      'Faster and more accurate than grep for "where is this defined" because the server tracks imports and re-exports.',
      'Returns the matching location(s) as `path:line:col`.',
    ].join(' '),
    schema: z.object({
      path: z.string().describe('Absolute or relative file path'),
      line: z.number().int().min(1).describe('1-based line number'),
      character: z.number().int().min(0).describe('0-based character offset on the line'),
    }),
    execute: async (params) => {
      const filePath = resolve(params.path as string);
      const line1 = params.line as number;
      const character = params.character as number;
      const client = await manager.getClientForFile(filePath);
      if (!client) {
        return fail(`No running LSP server for ${filePath}. Configure one under "lsp" in settings.json.`);
      }
      await notifyLSPs(manager, filePath);
      try {
        const locations = await client.getDefinition(pathToFileUri(filePath), line1 - 1, character);
        if (!locations || locations.length === 0) {
          return ok(`No definition found for ${relative(process.cwd(), filePath)}:${line1}:${character + 1}.`);
        }
        return ok(`${locations.length} definition${locations.length === 1 ? '' : 's'}:\n${formatLocations(locations, process.cwd())}`);
      } catch (err) {
        return fail(`lsp_definition failed: ${(err as Error).message}`);
      }
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
