/**
 * `notebook_edit` tool — read/write Jupyter `.ipynb` files cell-by-cell.
 *
 * Notebooks are JSON, but using `read_file` + `edit_file` on raw notebook
 * JSON is brittle: cell source can be a string OR an array of strings,
 * outputs include large base64 image blobs that pollute diffs, and
 * preserving metadata invariants by hand is error-prone. This tool gives
 * the model cell-aware operations that round-trip cleanly through nbformat.
 *
 * Spec: https://nbformat.readthedocs.io/en/latest/format_description.html
 */

import { writeFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { ok, fail } from './types.js';

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  id?: string;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

function readNotebook(path: string): Notebook {
  // Sync read is fine here — execute() awaits the surrounding work.
  const raw = readFileSync(path, 'utf-8');
  const nb = JSON.parse(raw) as Notebook;
  if (!nb.cells || !Array.isArray(nb.cells)) {
    throw new Error('Not a valid notebook (missing or invalid `cells`)');
  }
  if (typeof nb.nbformat !== 'number') {
    throw new Error('Not a valid notebook (missing `nbformat`)');
  }
  return nb;
}

/** Cell source can be a string or array-of-strings (per nbformat). Always
 *  return a string for display/edit; the writer normalizes back at save. */
function cellText(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
}

/** When writing, prefer the array-of-strings form (preserves git diffs
 *  better than a single huge string). Each line keeps its trailing \n. */
function toCellSource(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  // Append \n to every line except the last if the original didn't end in \n.
  // Simpler: always emit lines with \n suffix, drop the trailing empty if present.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && lines[i] === '') break;
    out.push(lines[i] + (i === lines.length - 1 ? '' : '\n'));
  }
  return out;
}

function makeCellId(): string {
  // nbformat 4.5+ wants a stable cell id (8-char hex is conventional).
  return Math.random().toString(16).slice(2, 10);
}

async function writeNotebook(path: string, nb: Notebook): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Pretty-print with 1-space indent — matches Jupyter's own save format
  // and keeps diffs readable. Trailing newline for POSIX-friendliness.
  await writeFile(path, JSON.stringify(nb, null, 1) + '\n', 'utf-8');
}

export function createNotebookEditTool(): ToolDef {
  return {
    name: 'notebook_edit',
    description: [
      'Edit Jupyter notebook (.ipynb) files cell-by-cell. Use this instead of read_file/edit_file for notebooks — JSON edits on cell source are brittle and can corrupt notebook metadata.',
      '',
      'Actions:',
      '  • list   — list all cells (index, type, first line of each).',
      '  • read   — return full source of a cell.',
      '  • edit   — replace source of a cell.',
      '  • insert — add a new cell at a given index (default: append).',
      '  • delete — remove a cell.',
    ].join('\n'),
    schema: z.object({
      path: z.string().describe('Path to .ipynb file. Created on insert if missing.'),
      action: z.enum(['list', 'read', 'edit', 'insert', 'delete']),
      index: z.number().optional().describe('Cell index (0-based). Required for read/edit/delete; optional for insert (default: append).'),
      content: z.string().optional().describe('New source for the cell. Required for edit/insert.'),
      cell_type: z.enum(['code', 'markdown', 'raw']).optional().describe('Cell type for insert (default: code).'),
    }),
    source: 'local',
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      const path = String(params.path ?? '');
      if (!path) return fail('notebook_edit requires `path`');
      const action = String(params.action ?? '');
      const absPath = resolve(path);

      try {
        if (action === 'list' || action === 'read' || action === 'edit' || action === 'delete') {
          if (!existsSync(absPath)) return fail(`Notebook does not exist: ${path}`);
        }

        if (action === 'list') {
          const nb = readNotebook(absPath);
          const lines = nb.cells.map((c, i) => {
            const text = cellText(c);
            const firstLine = text.split('\n')[0]?.slice(0, 80) ?? '';
            return `  [${String(i).padStart(2)}] ${c.cell_type.padEnd(8)} ${firstLine}`;
          });
          return ok(`${nb.cells.length} cells in ${path}:\n${lines.join('\n')}`);
        }

        if (action === 'read') {
          const nb = readNotebook(absPath);
          const idx = typeof params.index === 'number' ? params.index : -1;
          if (idx < 0 || idx >= nb.cells.length) {
            return fail(`Cell index ${idx} out of range (notebook has ${nb.cells.length} cells)`);
          }
          const cell = nb.cells[idx];
          return ok(`# ${cell.cell_type} cell ${idx}\n${cellText(cell)}`);
        }

        if (action === 'edit') {
          const idx = typeof params.index === 'number' ? params.index : -1;
          const content = typeof params.content === 'string' ? params.content : null;
          if (idx < 0) return fail('edit requires `index`');
          if (content === null) return fail('edit requires `content`');
          const nb = readNotebook(absPath);
          if (idx >= nb.cells.length) return fail(`Cell index ${idx} out of range (notebook has ${nb.cells.length} cells)`);
          nb.cells[idx].source = toCellSource(content);
          // Reset execution outputs on edit — the cell hasn't been re-run yet.
          if (nb.cells[idx].cell_type === 'code') {
            nb.cells[idx].outputs = [];
            nb.cells[idx].execution_count = null;
          }
          await writeNotebook(absPath, nb);
          return ok(`Edited cell ${idx} in ${path}.`);
        }

        if (action === 'insert') {
          const content = typeof params.content === 'string' ? params.content : '';
          const cellType = (params.cell_type as NotebookCell['cell_type']) ?? 'code';
          let nb: Notebook;
          if (existsSync(absPath)) {
            nb = readNotebook(absPath);
          } else {
            // Create a minimal valid notebook.
            nb = {
              cells: [],
              metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
              nbformat: 4,
              nbformat_minor: 5,
            };
          }
          const idx = typeof params.index === 'number'
            ? Math.max(0, Math.min(params.index, nb.cells.length))
            : nb.cells.length;
          const newCell: NotebookCell = {
            cell_type: cellType,
            source: toCellSource(content),
            metadata: {},
            id: makeCellId(),
          };
          if (cellType === 'code') {
            newCell.outputs = [];
            newCell.execution_count = null;
          }
          nb.cells.splice(idx, 0, newCell);
          await writeNotebook(absPath, nb);
          return ok(`Inserted ${cellType} cell at index ${idx} in ${path}.`);
        }

        if (action === 'delete') {
          const idx = typeof params.index === 'number' ? params.index : -1;
          if (idx < 0) return fail('delete requires `index`');
          const nb = readNotebook(absPath);
          if (idx >= nb.cells.length) return fail(`Cell index ${idx} out of range (notebook has ${nb.cells.length} cells)`);
          nb.cells.splice(idx, 1);
          await writeNotebook(absPath, nb);
          return ok(`Deleted cell ${idx} from ${path}.`);
        }

        return fail(`Unknown action: ${action}. Use list | read | edit | insert | delete.`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
