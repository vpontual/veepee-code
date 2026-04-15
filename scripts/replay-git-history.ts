#!/usr/bin/env tsx
/**
 * replay-git-history.ts — Execute a candidate model against the git-commit corpus.
 *
 * For each commit in benchmarks/git-corpus/commits.jsonl:
 *   1. Create a git worktree at the parent commit (pre-change state).
 *   2. Give the candidate: the commit message as user intent + the list of files
 *      it's allowed to edit, with their current contents.
 *   3. Candidate proposes edits (writes to the worktree files).
 *   4. Runner verifies: does `tsc --noEmit` pass in the worktree with the new edits?
 *   5. Optional: structural diff-similarity against the actual committed diff.
 *
 * Grading (binary, not 0-100):
 *   - PASS     → worktree typechecks cleanly after candidate's edits
 *   - COMPILE  → model wrote something, but typecheck fails
 *   - NOOP     → model declined to edit anything
 *   - ERROR    → model timed out, threw, or produced unrunnable output
 *
 * Typecheck is the minimum viable truth signal. A future upgrade can run the
 * actual test suite per commit, but that requires scoped tests-per-file mapping
 * that we don't have yet. Typecheck catches most "generated code doesn't fit"
 * failures cheaply.
 *
 * Worktrees share the main repo's node_modules via symlink to avoid per-sample
 * `npm install` cost (minutes → seconds). Scratch worktrees live under
 * benchmarks/scratch/git-replay/ and are cleaned up after each sample.
 *
 * Usage:
 *   npx tsx scripts/replay-git-history.ts --candidate qwen3-coder:30b \
 *     [--proxy http://10.0.153.99:11434] [--limit 20] [--timeout-s 120]
 *
 * Exit code is 0 if aggregate pass rate >= 0.50 (hard floor — below this the
 * model is effectively useless on repo-specific tasks), else 1.
 */

import { Ollama } from 'ollama';
import { execFileSync, spawnSync } from 'child_process';
import { readFile, writeFile, mkdir, rm, readdir, symlink, stat } from 'fs/promises';
import { resolve, dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CORPUS_PATH = resolve(REPO_ROOT, 'benchmarks', 'git-corpus', 'commits.jsonl');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'benchmarks', 'scratch', 'git-replay');
const REPORTS_DIR = resolve(REPO_ROOT, 'benchmarks', 'git-corpus');

const { values } = parseArgs({
  options: {
    candidate: { type: 'string' },
    proxy: { type: 'string', default: 'http://10.0.153.99:11434' },
    limit: { type: 'string', default: '20' },
    'timeout-s': { type: 'string', default: '120' },
    'keep-scratch': { type: 'boolean', default: false },
  },
  strict: false,
});

if (!values.candidate) {
  console.error('ERROR: --candidate <model> required');
  process.exit(1);
}

const CANDIDATE = values.candidate as string;
const PROXY = values.proxy as string;
const LIMIT = parseInt(values.limit as string, 10);
const TIMEOUT_MS = parseInt(values['timeout-s'] as string, 10) * 1000;
const KEEP_SCRATCH = values['keep-scratch'] as boolean;

interface CommitRecord {
  commit_hash: string;
  parent_hash: string;
  message: string;
  files_changed: string[];
  files_to_check: string[];
  stats: { additions: number; deletions: number; files: number };
  committed_at: string;
}

interface Verdict {
  commit_hash: string;
  parent_hash: string;
  message_subject: string;
  files: string[];
  verdict: 'PASS' | 'COMPILE' | 'NOOP' | 'ERROR';
  reason: string;
  elapsed_ms: number;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).trimEnd();
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function loadCorpus(): Promise<CommitRecord[]> {
  const raw = await readFile(CORPUS_PATH, 'utf-8');
  return raw.split('\n').filter(Boolean).map(l => JSON.parse(l) as CommitRecord);
}

async function setupWorktree(commit: CommitRecord, slot: number): Promise<string> {
  const dir = join(SCRATCH_ROOT, `slot-${slot}-${commit.commit_hash.slice(0, 10)}`);
  if (await exists(dir)) {
    git(REPO_ROOT, 'worktree', 'remove', '--force', dir);
  }
  git(REPO_ROOT, 'worktree', 'add', '--detach', dir, commit.parent_hash);
  // Symlink node_modules from main repo (avoid per-sample npm install)
  const nm = join(dir, 'node_modules');
  if (!(await exists(nm))) {
    await symlink(join(REPO_ROOT, 'node_modules'), nm, 'dir').catch(() => {});
  }
  return dir;
}

async function teardownWorktree(dir: string): Promise<void> {
  if (KEEP_SCRATCH) return;
  try {
    git(REPO_ROOT, 'worktree', 'remove', '--force', dir);
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildPrompt(commit: CommitRecord, fileContents: Record<string, string>): string {
  const fileBlocks = Object.entries(fileContents)
    .map(([path, body]) => `### ${path}\n\`\`\`typescript\n${body}\n\`\`\``)
    .join('\n\n');

  return [
    `You are modifying this repository to implement the following change.`,
    ``,
    `# Commit intent`,
    commit.message,
    ``,
    `# Files you may edit`,
    commit.files_to_check.join(', '),
    ``,
    `# Current state of those files`,
    fileBlocks,
    ``,
    `For each file that needs changes, call write_file with the FULL updated contents.`,
    `Alternatively use edit_file for small targeted changes (unique substring replacement).`,
    `Do not invent new files. Do not modify files outside the list above.`,
    `The result must typecheck cleanly with \`tsc --noEmit\`.`,
    `Stop when finished — do not explain your changes, the diff is self-evident.`,
  ].join('\n');
}

function typechecks(worktree: string): { ok: boolean; errors: string } {
  const result = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
    cwd: worktree,
    encoding: 'utf-8',
    timeout: 90_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const combined = (result.stdout || '') + (result.stderr || '');
  return { ok: result.status === 0, errors: combined.slice(0, 500) };
}

async function runCandidate(commit: CommitRecord, worktree: string, ollama: Ollama): Promise<{ edited: string[]; errors: string }> {
  const fileContents: Record<string, string> = {};
  for (const f of commit.files_to_check) {
    const p = join(worktree, f);
    try {
      fileContents[f] = await readFile(p, 'utf-8');
    } catch {
      // File may not exist at parent (commit may have added it). Treat as empty.
      fileContents[f] = '';
    }
  }

  const prompt = buildPrompt(commit, fileContents);
  const edited: string[] = [];

  // Lessons from replay-one-untimed.ts (verified PASS on the same corpus):
  //   - num_ctx:131072 so the model actually SEES the files in its prompt
  //     — src/benchmark.ts alone is ~20k tokens; with a 16k cap the prompt
  //     was silently truncated and the model hallucinated the edits.
  //   - num_predict:-1 (unlimited) so the model can emit full rewrites of
  //     large files when needed.
  //   - Expose both write_file (full rewrite) and edit_file (unique
  //     substring replace). Targeted edits are the right tool for a small
  //     commit and take a fraction of the tokens of a full rewrite.
  //   - No Promise.race timeout on the chat call. A 35B MoE at 25 tok/s
  //     generating 4000 tokens is already 160s; with thinking preamble and
  //     prompt eval on 20k+ tokens of context a single call can legitimately
  //     take 4–6 minutes. The caller (or ollama keep_alive) will still
  //     release resources if the process dies.
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

  const toolCalls = (response as any).message?.tool_calls || [];
  for (const call of toolCalls) {
    const name = call.function?.name;
    const args = call.function.arguments as Record<string, unknown>;
    const path = String(args?.path || '');
    if (!path) continue;
    // Refuse to write outside the allowed file set
    const rel = relative(worktree, join(worktree, path));
    if (rel.startsWith('..') || !commit.files_to_check.includes(path)) continue;
    if (name === 'write_file') {
      const content = args.content;
      if (typeof content !== 'string') continue;
      await writeFile(join(worktree, path), content, 'utf-8');
      edited.push(path);
    } else if (name === 'edit_file') {
      const oldStr = String(args.old_string || '');
      const newStr = String(args.new_string || '');
      if (!oldStr) continue;
      let before: string;
      try { before = await readFile(join(worktree, path), 'utf-8'); }
      catch { continue; }
      const count = before.split(oldStr).length - 1;
      if (count !== 1) continue;  // only accept unique-match edits
      await writeFile(join(worktree, path), before.replace(oldStr, newStr), 'utf-8');
      edited.push(path);
    }
  }
  return { edited, errors: '' };
}

async function replaySample(commit: CommitRecord, slot: number, ollama: Ollama): Promise<Verdict> {
  const start = Date.now();
  const subject = commit.message.split('\n')[0].slice(0, 80);
  let worktree = '';
  try {
    worktree = await setupWorktree(commit, slot);
    const { edited } = await runCandidate(commit, worktree, ollama);

    if (edited.length === 0) {
      return { commit_hash: commit.commit_hash, parent_hash: commit.parent_hash, message_subject: subject,
               files: commit.files_to_check, verdict: 'NOOP',
               reason: 'candidate made no file edits', elapsed_ms: Date.now() - start };
    }

    const tc = typechecks(worktree);
    if (tc.ok) {
      return { commit_hash: commit.commit_hash, parent_hash: commit.parent_hash, message_subject: subject,
               files: edited, verdict: 'PASS',
               reason: 'typechecks clean after edits', elapsed_ms: Date.now() - start };
    }
    return { commit_hash: commit.commit_hash, parent_hash: commit.parent_hash, message_subject: subject,
             files: edited, verdict: 'COMPILE',
             reason: `typecheck failed: ${tc.errors.split('\n').slice(0, 2).join(' | ').slice(0, 200)}`,
             elapsed_ms: Date.now() - start };
  } catch (e) {
    return { commit_hash: commit.commit_hash, parent_hash: commit.parent_hash, message_subject: subject,
             files: commit.files_to_check, verdict: 'ERROR',
             reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
             elapsed_ms: Date.now() - start };
  } finally {
    if (worktree) await teardownWorktree(worktree);
  }
}

async function main() {
  if (!(await exists(CORPUS_PATH))) {
    console.error(`ERROR: corpus not found at ${CORPUS_PATH}`);
    console.error(`Generate it first:  npx tsx scripts/extract-git-history.ts`);
    process.exit(1);
  }

  const corpus = (await loadCorpus()).slice(0, LIMIT);
  console.log(`Corpus: ${corpus.length} commits  |  candidate: ${CANDIDATE}  |  proxy: ${PROXY}`);
  console.log(`Worktree scratch: ${SCRATCH_ROOT}\n`);

  await mkdir(SCRATCH_ROOT, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });

  const ollama = new Ollama({ host: PROXY });
  const verdicts: Verdict[] = [];
  for (let i = 0; i < corpus.length; i++) {
    const v = await replaySample(corpus[i], i, ollama);
    verdicts.push(v);
    const subject = v.message_subject.slice(0, 60);
    console.log(`  [${i + 1}/${corpus.length}] ${v.verdict.padEnd(8)} (${(v.elapsed_ms / 1000).toFixed(1)}s) — ${subject}`);
  }

  const counts = { PASS: 0, COMPILE: 0, NOOP: 0, ERROR: 0 };
  for (const v of verdicts) counts[v.verdict]++;
  const passRate = Math.round((counts.PASS / verdicts.length) * 100);

  const modelSlug = CANDIDATE.replace(/[:\/]/g, '-');
  const reportPath = join(REPORTS_DIR, `replay-${modelSlug}-${new Date().toISOString().slice(0, 10)}.json`);
  await writeFile(reportPath, JSON.stringify({
    candidate: CANDIDATE,
    corpus_size: verdicts.length,
    counts,
    pass_rate: passRate,
    timestamp: new Date().toISOString(),
    verdicts,
  }, null, 2));

  console.log(`\n=== SUMMARY ===`);
  console.log(`  PASS:    ${counts.PASS}/${verdicts.length}  (${passRate}%)`);
  console.log(`  COMPILE: ${counts.COMPILE}/${verdicts.length}  (typecheck failed)`);
  console.log(`  NOOP:    ${counts.NOOP}/${verdicts.length}  (no edits attempted)`);
  console.log(`  ERROR:   ${counts.ERROR}/${verdicts.length}  (timeout/crash)`);
  console.log(`  Report:  ${reportPath}`);

  process.exit(passRate >= 50 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
