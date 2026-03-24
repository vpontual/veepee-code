import { readFile, writeFile, stat, readdir } from 'fs/promises';
import { resolve, relative, join } from 'path';
import { existsSync } from 'fs';
import { execSync, execFileSync, spawn } from 'child_process';
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
    createGithubTool(),
    createListFilesTool(),
    createUpdateMemoryTool(),
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
    description: 'Edit a file by replacing a string match. Provide old_string (text to find) and new_string (replacement). By default old_string must be unique; set replace_all=true to replace every occurrence.',
    schema: z.object({
      path: z.string().describe('File path to edit'),
      old_string: z.string().describe('The exact string to find and replace'),
      new_string: z.string().describe('The replacement string'),
      replace_all: z.boolean().optional().default(false).describe('Replace all occurrences instead of requiring uniqueness'),
    }),
    execute: async (params) => {
      try {
        const filePath = resolve(params.path as string);
        const content = await readFile(filePath, 'utf-8');
        const oldStr = params.old_string as string;
        const newStr = params.new_string as string;
        const replaceAll = params.replace_all as boolean;
        const relPath = relative(process.cwd(), filePath);

        let updated: string;
        let matchCount: number;

        // Exact match first
        const occurrences = content.split(oldStr).length - 1;

        if (occurrences > 0) {
          matchCount = occurrences;
          if (!replaceAll && occurrences > 1) {
            return fail(`old_string found ${occurrences} times in ${relPath} — it must be unique. Include more surrounding context, or set replace_all=true.`);
          }
          updated = replaceAll ? content.replaceAll(oldStr, newStr) : content.replace(oldStr, newStr);
        } else {
          // Fuzzy whitespace match: normalize tabs/spaces and try again
          const normalize = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
          const normalizedContent = normalize(content);
          const normalizedOld = normalize(oldStr);
          const fuzzyOccurrences = normalizedContent.split(normalizedOld).length - 1;

          if (fuzzyOccurrences === 0) {
            // Show nearby content to help the model
            const firstLine = oldStr.split('\n')[0].trim();
            const lineIdx = content.split('\n').findIndex(l => l.trim().includes(firstLine));
            const hint = lineIdx >= 0
              ? `\nNearest match around line ${lineIdx + 1}:\n${content.split('\n').slice(Math.max(0, lineIdx - 1), lineIdx + 3).map((l, i) => `  ${lineIdx + i}: ${l}`).join('\n')}`
              : '';
            return fail(`old_string not found in ${relPath}. Read the file first to get the exact content.${hint}`);
          }

          if (!replaceAll && fuzzyOccurrences > 1) {
            return fail(`old_string found ${fuzzyOccurrences} times (with whitespace normalization) — include more context.`);
          }

          // Find the actual string in the file that matches after normalization
          const lines = content.split('\n');
          const oldLines = oldStr.split('\n');
          let startLine = -1;

          for (let i = 0; i <= lines.length - oldLines.length; i++) {
            const slice = lines.slice(i, i + oldLines.length).join('\n');
            if (normalize(slice) === normalizedOld) {
              startLine = i;
              break;
            }
          }

          if (startLine === -1) {
            return fail(`Whitespace-fuzzy match found but could not locate exact position. Read the file and retry with exact content.`);
          }

          const actualOld = lines.slice(startLine, startLine + oldLines.length).join('\n');
          updated = content.replace(actualOld, newStr);
          matchCount = 1;
        }

        await writeFile(filePath, updated, 'utf-8');

        const oldLines = oldStr.split('\n');
        const newLines = newStr.split('\n');
        const diffLines: string[] = [`Edited ${relPath}${matchCount > 1 ? ` (${matchCount} replacements)` : ''}:`];
        for (const line of oldLines.slice(0, 10)) diffLines.push(`- ${line}`);
        if (oldLines.length > 10) diffLines.push(`  ... (${oldLines.length - 10} more lines)`);
        for (const line of newLines.slice(0, 10)) diffLines.push(`+ ${line}`);
        if (newLines.length > 10) diffLines.push(`  ... (${newLines.length - 10} more lines)`);
        return ok(diffLines.join('\n'));
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
        const pattern = params.pattern as string;

        // Use ripgrep if available, otherwise grep — with arg arrays to prevent injection
        const hasRg = (() => {
          try { execSync('which rg', { stdio: 'pipe' }); return true; } catch { return false; }
        })();

        let bin: string;
        let args: string[];
        if (hasRg) {
          bin = 'rg';
          args = ['-n', '--max-count', String(maxResults), '--no-heading'];
          if (include) args.push('--glob', include);
          args.push('--', pattern, searchPath);
        } else {
          bin = 'grep';
          args = ['-rn', `--max-count=${maxResults}`];
          if (include) args.push(`--include=${include}`);
          args.push('-E', '--', pattern, searchPath);
        }

        const output = execFileSync(bin, args, {
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
        const MAX_OUTPUT = 512 * 1024; // 512KB cap per stream
        let truncated = false;

        child.stdout.on('data', (data: Buffer) => {
          if (stdout.length < MAX_OUTPUT) {
            stdout += data.toString();
          } else if (!truncated) {
            truncated = true;
            stdout += '\n...(output truncated at 512KB)';
          }
        });
        child.stderr.on('data', (data: Buffer) => {
          if (stderr.length < MAX_OUTPUT) {
            stderr += data.toString();
          }
        });

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
        // Parse args string into array to avoid shell injection
        // Uses a simple split that respects quoted strings
        const argsStr = (params.args as string) || '';
        const gitArgs = parseArgs(argsStr);
        const output = execFileSync('git', gitArgs, {
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

/** Parse a command string into an array, respecting quoted strings */
function parseArgs(str: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (const ch of str) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { args.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

function createGithubTool(): ToolDef {
  return {
    name: 'github',
    description: 'Interact with GitHub via the gh CLI. Manage repos, pull requests, issues, and releases. Actions: repo_create, repo_list, pr_create, pr_list, pr_view, pr_merge, pr_comment, pr_diff, pr_checks, issue_create, issue_list, issue_view, issue_comment, release_create, release_list.',
    schema: z.object({
      action: z.enum([
        'repo_create', 'repo_list',
        'pr_create', 'pr_list', 'pr_view', 'pr_merge', 'pr_comment', 'pr_diff', 'pr_checks',
        'issue_create', 'issue_list', 'issue_view', 'issue_comment',
        'release_create', 'release_list',
      ]).describe(
        'repo_create: create a new repo. repo_list: list your repos. ' +
        'pr_create: open a PR. pr_list: list PRs. pr_view: view PR details. pr_merge: merge a PR. pr_comment: comment on a PR. pr_diff: view PR diff. pr_checks: view PR CI status. ' +
        'issue_create: create an issue. issue_list: list issues. issue_view: view issue details. issue_comment: comment on an issue. ' +
        'release_create: create a release. release_list: list releases.',
      ),
      repo: z.string().optional().describe("Repository in owner/name format (e.g. 'vpontual/newsfeed'). Omit to use the repo in cwd."),
      title: z.string().optional().describe('Title for PR, issue, release, or new repo name'),
      body: z.string().optional().describe('Body/description for PR, issue, release, or comment text'),
      branch: z.string().optional().describe('Branch name for PR (head branch) or release tag'),
      base: z.string().optional().describe('Base branch for PR (default: repo default branch)'),
      number: z.number().optional().describe('PR or issue number (for view/merge/comment actions)'),
      labels: z.string().optional().describe('Comma-separated labels for PR or issue'),
      draft: z.boolean().optional().describe('Create PR as draft'),
      is_private: z.boolean().optional().describe('Create repo as private (default true)'),
      limit: z.number().optional().describe('Max results for list actions (default 20)'),
      cwd: z.string().optional().describe('Git repository directory'),
    }),
    execute: async (params) => {
      const action = params.action as string;
      const repo = params.repo as string | undefined;
      const title = params.title as string | undefined;
      const body = params.body as string | undefined;
      const branch = params.branch as string | undefined;
      const base = params.base as string | undefined;
      const number = params.number as number | undefined;
      const labels = params.labels as string | undefined;
      const draft = params.draft as boolean | undefined;
      const isPrivate = params.is_private as boolean | undefined;
      const limit = (params.limit as number) || 20;
      const cwd = resolve((params.cwd as string) || process.cwd());

      const rf = repo ? ['-R', repo] : [];

      function runGh(args: string[]): ToolResult {
        try {
          const output = execFileSync('gh', args, {
            cwd,
            encoding: 'utf-8',
            maxBuffer: 2 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30_000,
          });
          return ok(output.trim() || '(no output)');
        } catch (err) {
          const error = err as { stderr?: string; stdout?: string; message?: string };
          const out = [error.stdout, error.stderr ?? error.message].filter(Boolean).join('\n').trim();
          return fail(out || 'gh command failed');
        }
      }

      switch (action) {
        // ---- Repos ----
        case 'repo_create': {
          if (!title) return fail("Missing 'title' (repo name) for repo_create");
          const a = ['repo', 'create', title, isPrivate === false ? '--public' : '--private', '--confirm'];
          if (body) a.push('--description', body);
          return runGh(a);
        }
        case 'repo_list':
          return runGh(['repo', 'list', '--limit', String(limit)]);

        // ---- Pull Requests ----
        case 'pr_create': {
          if (!title) return fail("Missing 'title' for pr_create");
          const a = ['pr', 'create', '--title', title, ...rf];
          if (body) a.push('--body', body);
          if (branch) a.push('--head', branch);
          if (base) a.push('--base', base);
          if (labels) a.push('--label', labels);
          if (draft) a.push('--draft');
          return runGh(a);
        }
        case 'pr_list':
          return runGh(['pr', 'list', '--limit', String(limit), ...rf]);
        case 'pr_view': {
          if (!number) return fail("Missing 'number' for pr_view");
          return runGh(['pr', 'view', String(number), ...rf]);
        }
        case 'pr_merge': {
          if (!number) return fail("Missing 'number' for pr_merge");
          return runGh(['pr', 'merge', String(number), '--merge', ...rf]);
        }
        case 'pr_comment': {
          if (!number) return fail("Missing 'number' for pr_comment");
          if (!body) return fail("Missing 'body' for pr_comment");
          return runGh(['pr', 'comment', String(number), '--body', body, ...rf]);
        }
        case 'pr_diff': {
          if (!number) return fail("Missing 'number' for pr_diff");
          return runGh(['pr', 'diff', String(number), ...rf]);
        }
        case 'pr_checks': {
          if (!number) return fail("Missing 'number' for pr_checks");
          return runGh(['pr', 'checks', String(number), ...rf]);
        }

        // ---- Issues ----
        case 'issue_create': {
          if (!title) return fail("Missing 'title' for issue_create");
          const a = ['issue', 'create', '--title', title, ...rf];
          if (body) a.push('--body', body);
          if (labels) a.push('--label', labels);
          return runGh(a);
        }
        case 'issue_list':
          return runGh(['issue', 'list', '--limit', String(limit), ...rf]);
        case 'issue_view': {
          if (!number) return fail("Missing 'number' for issue_view");
          return runGh(['issue', 'view', String(number), ...rf]);
        }
        case 'issue_comment': {
          if (!number) return fail("Missing 'number' for issue_comment");
          if (!body) return fail("Missing 'body' for issue_comment");
          return runGh(['issue', 'comment', String(number), '--body', body, ...rf]);
        }

        // ---- Releases ----
        case 'release_create': {
          if (!branch) return fail("Missing 'branch' (tag name) for release_create");
          const a = ['release', 'create', branch, ...rf];
          if (title) a.push('--title', title);
          if (body) a.push('--notes', body);
          return runGh(a);
        }
        case 'release_list':
          return runGh(['release', 'list', '--limit', String(limit), ...rf]);

        default:
          return fail(`Unknown github action: ${action}`);
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

function createUpdateMemoryTool(): ToolDef {
  return {
    name: 'update_memory',
    description: 'Store an important fact, decision, or context in the conversation knowledge state. Use this when you learn something important that should persist across the conversation. Keys: fact, decision, question, project, current_task, or any custom key.',
    schema: z.object({
      key: z.string().describe('Category: fact, decision, question, project, current_task, or custom key'),
      value: z.string().describe('The information to remember'),
    }),
    execute: async (params) => {
      // Actual storage is handled by the agent (intercepted before reaching here)
      return ok(`Stored: ${params.key} = ${params.value}`);
    },
  };
}
