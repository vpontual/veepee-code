#!/usr/bin/env tsx
/**
 * replay-one-untimed.ts — Single-sample git-history replay with NO timeouts.
 *
 * Deliberately strips every time bound from replay-git-history.ts:
 *   - no Promise.race timeout on the chat call
 *   - no wall-clock process limit
 *   - num_predict: -1 (Ollama unlimited)
 *   - num_ctx: 131072 (large enough for any single file in this repo)
 *
 * Runs one commit and reports PASS / COMPILE / NOOP based on whether the
 * candidate's edits make the worktree typecheck. Whatever the model produces,
 * however long it takes, we wait.
 *
 * Usage:
 *   npx tsx scripts/replay-one-untimed.ts --candidate qwen3-coder-next:latest [--index 0]
 *
 * --index N selects the Nth commit in benchmarks/git-corpus/commits.jsonl (0-based).
 */
import { Ollama } from 'ollama';
import { execFileSync, spawnSync } from 'child_process';
import { readFile, writeFile, mkdir, rm, symlink, stat } from 'fs/promises';
import { resolve, dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CORPUS_PATH = resolve(REPO_ROOT, 'benchmarks', 'git-corpus', 'commits.jsonl');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'benchmarks', 'scratch', 'git-replay-untimed');

const { values } = parseArgs({
  options: {
    candidate: { type: 'string' },
    proxy: { type: 'string', default: 'http://10.0.154.246:11434' },
    index: { type: 'string', default: '0' },
  },
  strict: false,
});

if (!values.candidate) {
  console.error('ERROR: --candidate <model> required');
  process.exit(2);
}

const CANDIDATE = values.candidate as string;
const PROXY = values.proxy as string;
const INDEX = parseInt(values.index as string, 10);

interface CommitRecord {
  commit_hash: string;
  parent_hash: string;
  message: string;
  files_to_check: string[];
  stats: { additions: number; deletions: number; files: number };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).trimEnd();
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  const raw = await readFile(CORPUS_PATH, 'utf-8');
  const records = raw.split('\n').filter(Boolean).map(l => JSON.parse(l) as CommitRecord);
  const c = records[INDEX];
  if (!c) { console.error(`No record at index ${INDEX}`); process.exit(1); }

  console.log(`=== Single-sample replay (no timeouts) ===`);
  console.log(`  Candidate: ${CANDIDATE}`);
  console.log(`  Proxy:     ${PROXY}`);
  console.log(`  Commit:    ${c.commit_hash.slice(0, 10)}`);
  console.log(`  Subject:   ${c.message.split('\n')[0]}`);
  console.log(`  Files:     ${c.files_to_check.join(', ')}`);
  console.log(`  Stats:     +${c.stats.additions} -${c.stats.deletions} across ${c.stats.files} files`);
  console.log();

  await mkdir(SCRATCH_ROOT, { recursive: true });
  const worktree = join(SCRATCH_ROOT, `${c.commit_hash.slice(0, 10)}`);
  if (await exists(worktree)) {
    try { git(REPO_ROOT, 'worktree', 'remove', '--force', worktree); } catch { /* ignore */ }
  }
  git(REPO_ROOT, 'worktree', 'add', '--detach', worktree, c.parent_hash);
  const nm = join(worktree, 'node_modules');
  if (!(await exists(nm))) { await symlink(join(REPO_ROOT, 'node_modules'), nm, 'dir').catch(() => {}); }

  // Build prompt — current file contents at the parent commit
  const fileContents: Record<string, string> = {};
  for (const f of c.files_to_check) {
    const p = join(worktree, f);
    try { fileContents[f] = await readFile(p, 'utf-8'); }
    catch { fileContents[f] = ''; }
  }
  const blocks = Object.entries(fileContents)
    .map(([p, b]) => `### ${p}\n\n\`\`\`typescript\n${b}\n\`\`\``)
    .join('\n\n');

  const prompt = [
    `Modify this repository to implement the change described below.`,
    ``,
    `# Commit intent`,
    c.message,
    ``,
    `# Files you may edit`,
    c.files_to_check.join(', '),
    ``,
    `# Current state of those files (at parent commit)`,
    blocks,
    ``,
    `For each file that needs changes, call write_file with the FULL updated contents.`,
    `Alternatively use edit_file for small targeted changes.`,
    `Do not invent new files. Do not touch files outside the list above.`,
    `The result must typecheck cleanly with tsc --noEmit. Stop when finished.`,
  ].join('\n');

  console.log(`Prompt length: ~${Math.round(prompt.length / 4)} tokens`);
  console.log(`Calling ${CANDIDATE}... (NO TIMEOUT — will wait as long as it takes)\n`);

  const ollama = new Ollama({ host: PROXY });
  const start = Date.now();
  const response = await ollama.chat({
    model: CANDIDATE,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    think: false as any,
    keep_alive: '30m',
    options: { temperature: 0.1, num_predict: -1, num_ctx: 131072 },
    tools: [
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write the full updated contents of a file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'edit_file',
          description: 'Replace a unique substring in an existing file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' },
            },
            required: ['path', 'old_string', 'new_string'],
          },
        },
      },
    ],
  });
  const elapsed = Date.now() - start;
  console.log(`Model responded in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`  content length: ${(response.message.content || '').length} chars`);
  console.log(`  tool_calls: ${response.message.tool_calls?.length ?? 0}`);
  console.log();

  const edited: string[] = [];
  const toolCalls = response.message.tool_calls || [];
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    const args = tc.function?.arguments as Record<string, unknown>;
    const path = String(args?.path || '');
    if (!path) continue;
    const abs = join(worktree, path);
    const rel = relative(worktree, abs);
    if (rel.startsWith('..') || !c.files_to_check.includes(path)) {
      console.log(`  SKIP ${name}(${path}) — outside allowed file list`);
      continue;
    }
    if (name === 'write_file') {
      await writeFile(abs, String(args.content || ''), 'utf-8');
      edited.push(path);
      console.log(`  write_file(${path}) — ${String(args.content || '').length} chars`);
    } else if (name === 'edit_file') {
      const before = await readFile(abs, 'utf-8');
      const oldStr = String(args.old_string || '');
      const newStr = String(args.new_string || '');
      const count = before.split(oldStr).length - 1;
      if (count !== 1) {
        console.log(`  edit_file(${path}) — old_string ${count === 0 ? 'not found' : `matched ${count} times`}, SKIPPED`);
        continue;
      }
      await writeFile(abs, before.replace(oldStr, newStr), 'utf-8');
      edited.push(path);
      console.log(`  edit_file(${path}) — ok`);
    }
  }

  if (edited.length === 0) {
    console.log(`\nVERDICT: NOOP — candidate made no usable file edits`);
    process.exit(1);
  }

  console.log(`\nRunning tsc --noEmit in ${worktree}...`);
  const tc = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
    cwd: worktree, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024,
  });
  if (tc.status === 0) {
    console.log(`\nVERDICT: PASS — typechecks clean in ${((Date.now() - start) / 1000).toFixed(0)}s total`);
    process.exit(0);
  }
  const err = ((tc.stdout || '') + (tc.stderr || '')).slice(0, 1500);
  console.log(`\nVERDICT: COMPILE — edits applied but typecheck failed:`);
  console.log(err);
  process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
