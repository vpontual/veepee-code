import { readFile, writeFile, stat, readdir } from 'fs/promises';
import { resolve, relative, join } from 'path';
import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { glob as globFn } from 'glob';
import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { ok, fail } from './types.js';

export function registerCodingTools(): ToolDef[] {
  return [
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createGlobTool(),
    createGrepTool(),
    createBashTool(),
    createGitTool(),
    createListFilesTool(),
  ];
}

function createReadFileTool(): ToolDef {
  return {
    name: 'read_file',
    description: 'Read a file from the filesystem. Returns the full file content with line numbers. Use this to understand code before making changes.',
    schema: z.object({
      path: z.string().describe('Absolute or relative file path to read'),
      offset: z.number().optional().describe('Start reading from this line number (1-based)'),
      limit: z.number().optional().describe('Maximum number of lines to return'),
    }),
    execute: async (params) => {
      try {
        const filePath = resolve(params.path as string);
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        const offset = ((params.offset as number) || 1) - 1;
        const limit = (params.limit as number) || lines.length;
        const slice = lines.slice(offset, offset + limit);

        const numbered = slice
          .map((line, i) => `${String(offset + i + 1).padStart(5)}  ${line}`)
          .join('\n');

        return ok(numbered);
      } catch (err) {
        return fail(`Cannot read file: ${(err as Error).message}`);
      }
    },
  };
}

function createWriteFileTool(): ToolDef {
  return {
    name: 'write_file',
    description: 'Write content to a file, creating it if it does not exist or overwriting if it does. Use for creating new files.',
    schema: z.object({
      path: z.string().describe('File path to write to'),
      content: z.string().describe('The full content to write to the file'),
    }),
    execute: async (params) => {
      try {
        const filePath = resolve(params.path as string);
        await writeFile(filePath, params.content as string, 'utf-8');
        const lines = (params.content as string).split('\n').length;
        return ok(`Wrote ${lines} lines to ${relative(process.cwd(), filePath)}`);
      } catch (err) {
        return fail(`Cannot write file: ${(err as Error).message}`);
      }
    },
  };
}

function createEditFileTool(): ToolDef {
  return {
    name: 'edit_file',
    description: 'Edit a file by replacing an exact string match. Provide old_string (the exact text to find) and new_string (the replacement). The old_string must match exactly including whitespace and indentation.',
    schema: z.object({
      path: z.string().describe('File path to edit'),
      old_string: z.string().describe('The exact string to find and replace. Must be unique in the file.'),
      new_string: z.string().describe('The replacement string'),
    }),
    execute: async (params) => {
      try {
        const filePath = resolve(params.path as string);
        const content = await readFile(filePath, 'utf-8');
        const oldStr = params.old_string as string;
        const newStr = params.new_string as string;

        // Check that old_string exists and is unique
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
          return fail(`old_string not found in ${relative(process.cwd(), filePath)}. Read the file first to get the exact content.`);
        }
        if (occurrences > 1) {
          return fail(`old_string found ${occurrences} times — it must be unique. Include more surrounding context.`);
        }

        const updated = content.replace(oldStr, newStr);
        await writeFile(filePath, updated, 'utf-8');

        const addedLines = newStr.split('\n').length;
        const removedLines = oldStr.split('\n').length;
        return ok(`Edited ${relative(process.cwd(), filePath)}: -${removedLines} +${addedLines} lines`);
      } catch (err) {
        return fail(`Cannot edit file: ${(err as Error).message}`);
      }
    },
  };
}

function createGlobTool(): ToolDef {
  return {
    name: 'glob',
    description: 'Find files matching a glob pattern. Use patterns like "**/*.ts", "src/**/*.js", "*.json". Returns matching file paths.',
    schema: z.object({
      pattern: z.string().describe('Glob pattern to match files (e.g. "**/*.ts", "src/**/*.js")'),
      cwd: z.string().optional().describe('Directory to search in (defaults to working directory)'),
    }),
    execute: async (params) => {
      try {
        const cwd = resolve((params.cwd as string) || process.cwd());
        const matches = await globFn(params.pattern as string, {
          cwd,
          ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', '.next/**'],
          nodir: true,
        });

        if (matches.length === 0) {
          return ok('No files matched the pattern.');
        }

        const sorted = matches.sort();
        const output = sorted.length > 100
          ? sorted.slice(0, 100).join('\n') + `\n... and ${sorted.length - 100} more`
          : sorted.join('\n');

        return ok(`Found ${matches.length} files:\n${output}`);
      } catch (err) {
        return fail(`Glob failed: ${(err as Error).message}`);
      }
    },
  };
}

function createGrepTool(): ToolDef {
  return {
    name: 'grep',
    description: 'Search file contents using a regex pattern. Returns matching lines with file paths and line numbers. Great for finding where functions, classes, or patterns are defined or used.',
    schema: z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      path: z.string().optional().describe('File or directory to search in (defaults to working directory)'),
      include: z.string().optional().describe('File pattern to include (e.g. "*.ts", "*.py")'),
      max_results: z.number().optional().describe('Maximum number of results (default 50)'),
    }),
    execute: async (params) => {
      try {
        const searchPath = resolve((params.path as string) || '.');
        const include = params.include as string | undefined;
        const maxResults = (params.max_results as number) || 50;

        // Use ripgrep if available, otherwise grep
        const hasRg = (() => {
          try { execSync('which rg', { stdio: 'pipe' }); return true; } catch { return false; }
        })();

        let cmd: string;
        if (hasRg) {
          cmd = `rg -n --max-count ${maxResults} --no-heading`;
          if (include) cmd += ` --glob "${include}"`;
          cmd += ` "${params.pattern}" "${searchPath}"`;
        } else {
          cmd = `grep -rn --max-count=${maxResults}`;
          if (include) cmd += ` --include="${include}"`;
          cmd += ` -E "${params.pattern}" "${searchPath}"`;
        }

        const output = execSync(cmd, {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (!output) return ok('No matches found.');

        const lines = output.split('\n');
        const result = lines.length > maxResults
          ? lines.slice(0, maxResults).join('\n') + `\n... (truncated at ${maxResults} results)`
          : output;

        return ok(`${lines.length} matches:\n${result}`);
      } catch (err) {
        const error = err as { status?: number; message?: string; stdout?: string };
        // grep returns exit code 1 for no matches
        if (error.status === 1) return ok('No matches found.');
        return fail(`Search failed: ${error.message || 'Unknown error'}`);
      }
    },
  };
}

function createBashTool(): ToolDef {
  return {
    name: 'bash',
    description: 'Execute a shell command and return its output. Use for running builds, tests, package managers, system commands, or any operation that needs shell access.',
    schema: z.object({
      command: z.string().describe('The shell command to execute'),
      cwd: z.string().optional().describe('Working directory for the command'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default 120000)'),
    }),
    execute: async (params) => {
      return new Promise<ToolResult>((res) => {
        const cwd = resolve((params.cwd as string) || process.cwd());
        const timeout = (params.timeout as number) || 120_000;

        const child = spawn('bash', ['-c', params.command as string], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout,
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        child.on('close', (code) => {
          const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
          if (code === 0) {
            res(ok(output.trim() || '(no output)'));
          } else {
            res(fail(`Exit code ${code}\n${output.trim()}`));
          }
        });

        child.on('error', (err) => {
          res(fail(`Command failed: ${err.message}`));
        });
      });
    },
  };
}

function createGitTool(): ToolDef {
  return {
    name: 'git',
    description: 'Run git commands. Supports all git operations: status, diff, log, add, commit, branch, checkout, push, pull, etc.',
    schema: z.object({
      args: z.string().describe('Git arguments (e.g. "status", "diff --staged", "log --oneline -10")'),
      cwd: z.string().optional().describe('Repository directory'),
    }),
    execute: async (params) => {
      try {
        const cwd = resolve((params.cwd as string) || process.cwd());
        const output = execSync(`git ${params.args}`, {
          cwd,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return ok(output.trim() || '(no output)');
      } catch (err) {
        const error = err as { stderr?: string; message?: string };
        return fail(error.stderr?.trim() || error.message || 'git command failed');
      }
    },
  };
}

function createListFilesTool(): ToolDef {
  return {
    name: 'list_files',
    description: 'List files and directories in a given path. Returns names with type indicators (/ for directories).',
    schema: z.object({
      path: z.string().optional().describe('Directory path to list (defaults to working directory)'),
      recursive: z.boolean().optional().describe('List recursively (default false, max 2 levels)'),
    }),
    execute: async (params) => {
      try {
        const dirPath = resolve((params.path as string) || '.');
        const recursive = params.recursive as boolean;

        if (recursive) {
          const entries = await globFn('**/*', {
            cwd: dirPath,
            ignore: ['node_modules/**', '.git/**', 'dist/**'],
            mark: true,
            maxDepth: 2,
          });
          return ok(entries.sort().join('\n') || '(empty directory)');
        }

        const entries = await readdir(dirPath, { withFileTypes: true });
        const lines = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(e => e.isDirectory() ? `${e.name}/` : e.name);
        return ok(lines.join('\n') || '(empty directory)');
      } catch (err) {
        return fail(`Cannot list directory: ${(err as Error).message}`);
      }
    },
  };
}
