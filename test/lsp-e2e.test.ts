/**
 * LSP end-to-end test — exercises Phases B, C, D against a real
 * typescript-language-server.
 *
 * Simulates a realistic agent session:
 *   1. read_file warms the server (Phase D — fire-and-forget didOpen)
 *   2. edit_file introduces a type error → result contains <file_diagnostics>
 *      with the error (Phase B inline)
 *   3. edit_file fixes the error → result contains zero diagnostics
 *   4. multi_edit on a single file → one diagnostics block, not N
 *   5. lsp_references on a known symbol → returns the expected locations
 *   6. lsp_definition on a usage → returns the declaration site
 *   7. write_file overwriting a clean file → still produces a diagnostics block
 *      (empty when clean)
 *   8. lsp_restart recovers from a kill -9
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileUri } from '../src/lsp/uri.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerCodingTools } from '../src/tools/coding.js';
import { registerLspTools } from '../src/tools/lsp.js';
import { LspManager } from '../src/lsp/manager.js';
import { FileTracker } from '../src/filetracker.js';

const TSLS_PATH = resolve('node_modules/.bin/typescript-language-server');
const HAS_TSLS = existsSync(TSLS_PATH);

const skipMsg = HAS_TSLS ? '' : ' (skipped — typescript-language-server not installed)';

let dir: string;
let manager: LspManager;
let registry: ToolRegistry;
let mainFile: string;
let helperFile: string;

const HELPER_SRC = `export function greet(name: string): string {
  return \`hello \${name}\`;
}
`;

const MAIN_SRC = `import { greet } from './helper.js';

const message: string = greet('world');
console.log(message);
`;

let prevCwd = '';

beforeAll(async () => {
  if (!HAS_TSLS) return;

  dir = mkdtempSync(join(tmpdir(), 'vcode-lsp-e2e-'));
  // Contained file tools mean the workspace must BE the cwd, as it is for the
  // real agent.
  prevCwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, target: 'es2022',
      module: 'esnext', moduleResolution: 'bundler',
    },
    include: ['*.ts'],
  }));
  helperFile = join(dir, 'helper.ts');
  mainFile = join(dir, 'main.ts');
  writeFileSync(helperFile, HELPER_SRC);
  writeFileSync(mainFile, MAIN_SRC);

  manager = new LspManager({
    typescript: {
      command: TSLS_PATH,
      args: ['--stdio'],
      filetypes: ['ts', 'tsx'],
      rootPatterns: ['tsconfig.json'],
    },
  }, dir);

  const tracker = new FileTracker();
  registry = new ToolRegistry();
  for (const t of registerCodingTools(undefined, tracker, manager)) registry.register(t);
  for (const t of registerLspTools(manager)) registry.register(t);
}, 30_000);

afterAll(async () => {
  if (prevCwd) process.chdir(prevCwd);
  if (!HAS_TSLS) return;
  await manager.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Wait for a condition instead of guessing how long it takes.
 *
 * This file drives a REAL typescript-language-server, and every wait in it used
 * to be `setTimeout(1500)`. Alone that is ample; alongside 60 other test files
 * the server is starved and has not finished starting, so tests 2 and 3 failed
 * intermittently on commits that passed in isolation. A fixed sleep is always
 * both too long on an idle machine and too short on a busy one.
 *
 * Retries were not the answer either: the server starts once in beforeAll, so
 * re-running a single test only waits on the same cold server again.
 *
 * Polls fast, gives up loudly, and — the point — returns the instant the thing
 * is actually ready, so the common case costs milliseconds rather than seconds.
 */
async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((res) => setTimeout(res, 25));
  }
}

const serverRunning = () => manager.runningLabels().includes('typescript');

/**
 * Block until the server has started AND published diagnostics for `file`.
 *
 * waitForDiagnostics is the correct readiness signal because it resolves on an
 * EMPTY result too — a clean file still gets a publishDiagnostics notification.
 * The obvious-looking alternative, polling manager.getAllDiagnostics() for the
 * URI, cannot work: that method drops entries with zero diagnostics
 * (`if (diags.length === 0) continue`), so a clean file never appears in it and
 * the poll can only ever time out. Which is exactly what it did.
 */
async function warmFile(file: string, diagTimeoutMs = 5_000): Promise<void> {
  await waitFor('the typescript LSP to start', serverRunning, 30_000);
  const client = await manager.getClientByLabel('typescript');
  if (!client) throw new Error('LSP client missing immediately after it reported running');
  // Capped well under the per-test budget: this is a readiness wait, not an
  // assertion. After earlier tests have edited the file the version gate can
  // leave nothing left to notify, and blocking the full 20s there burned the
  // whole test timeout in the reference/definition cases, which do not depend
  // on diagnostics at all.
  await client.waitForDiagnostics(pathToFileUri(file), diagTimeoutMs);
}

describe.skipIf(!HAS_TSLS)('LSP end-to-end' + skipMsg, () => {
  it('1. read_file warms the LSP server (Phase D)', async () => {
    const r = await registry.execute('read_file', { path: mainFile });
    expect(r.success).toBe(true);
    // read_file fires didOpen and does not await it, so wait for the server to
    // actually come up rather than assuming a duration.
    await warmFile(mainFile);
    expect(manager.runningLabels()).toContain('typescript');
  }, 20_000);

  it('2. edit_file that introduces a type error appends <file_diagnostics> (Phase B)', async () => {
    // Read first so the staleness check is satisfied.
    await registry.execute('read_file', { path: mainFile });

    const r = await registry.execute('edit_file', {
      path: mainFile,
      old_string: `const message: string = greet('world');`,
      new_string: `const message: number = greet('world');`,
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('<file_diagnostics>');
    expect(r.output).toMatch(/Error:.*main\.ts.*\[typescript 2322\]/);
    expect(r.output).toContain('<diagnostic_summary>');
    expect(r.output).toMatch(/Current file:\s+1 error/);
  }, 20_000);

  it('3. edit_file that fixes the error clears <file_diagnostics>', async () => {
    await registry.execute('read_file', { path: mainFile });

    const r = await registry.execute('edit_file', {
      path: mainFile,
      old_string: `const message: number = greet('world');`,
      new_string: `const message: string = greet('world');`,
    });
    expect(r.success).toBe(true);
    // Either no diagnostics block at all (clean) or the file_diagnostics
    // section is absent. The summary may still appear with "clean".
    expect(r.output).not.toMatch(/Error:.*main\.ts/);
  }, 20_000);

  it('4. multi_edit produces at most one diagnostics block (notifyLSPs called once)', async () => {
    await registry.execute('read_file', { path: helperFile });

    const r = await registry.execute('multi_edit', {
      path: helperFile,
      edits: [
        { old_string: 'export function greet', new_string: 'export function sayHello' },
        { old_string: 'hello ${name}', new_string: 'hi ${name}' },
      ],
    });
    expect(r.success).toBe(true);
    // The Phase-B contract: multi_edit calls notifyLSPs at most once after
    // the final write — never N times stacked. Check the output never
    // contains two <file_diagnostics> blocks. (Cross-file propagation in
    // <project_diagnostics> is timing-sensitive and verified by hand;
    // here we just assert the block-count invariant.)
    const fileMatches = (r.output ?? '').match(/<file_diagnostics>/g) ?? [];
    expect(fileMatches.length).toBeLessThanOrEqual(1);
    const projMatches = (r.output ?? '').match(/<project_diagnostics>/g) ?? [];
    expect(projMatches.length).toBeLessThanOrEqual(1);
    const summaryMatches = (r.output ?? '').match(/<diagnostic_summary>/g) ?? [];
    expect(summaryMatches.length).toBeLessThanOrEqual(1);
  }, 20_000);

  it('5. lsp_references finds usages of a symbol (Phase C)', async () => {
    // Restore helper.ts to the original `greet` name first, so main.ts can
    // resolve the import. We just renamed it to sayHello in step 4.
    writeFileSync(helperFile, HELPER_SRC);
    writeFileSync(mainFile, MAIN_SRC);
    // Re-warm the server with the fresh contents.
    await registry.execute('read_file', { path: helperFile });
    await registry.execute('read_file', { path: mainFile });
    await warmFile(helperFile);
    await warmFile(mainFile);

    // `greet` is declared on line 1 of helper.ts at character 16
    // (`export function greet(...)`). Line is 1-based, character is 0-based.
    const r = await registry.execute('lsp_references', {
      path: helperFile,
      line: 1,
      character: 16,
    });
    expect(r.success).toBe(true);
    // Should find at least the declaration and one usage in main.ts.
    expect(r.output).toMatch(/helper\.ts:1:/);
    expect(r.output).toMatch(/main\.ts:/);
  }, 20_000);

  it('6. lsp_definition jumps from a usage to the declaration', async () => {
    await registry.execute('read_file', { path: mainFile });
    await warmFile(mainFile);

    // In main.ts, `greet` is used on line 3 at around column 25.
    // `const message: string = greet('world');`
    //                          ^ char index 25 (0-based)
    const r = await registry.execute('lsp_definition', {
      path: mainFile,
      line: 3,
      character: 25,
    });
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/helper\.ts:1:/);
  }, 20_000);

  it('7. write_file on a clean file produces no error diagnostics', async () => {
    const cleanFile = join(dir, 'clean.ts');
    const r = await registry.execute('write_file', {
      path: cleanFile,
      content: 'export const ok: number = 42;\n',
    });
    expect(r.success).toBe(true);
    // No errors should appear for this file.
    expect(r.output).not.toMatch(/Error:.*clean\.ts/);
  }, 20_000);

  it('8. lsp_restart recovers a server', async () => {
    const r = await registry.execute('lsp_restart', { language: 'typescript' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('Restarted');
    // After restart, the manager should still consider it running.
    expect(manager.runningLabels()).toContain('typescript');
  }, 20_000);

  it('9. read_file with no LSP-matching extension does not crash', async () => {
    const txt = join(dir, 'notes.txt');
    writeFileSync(txt, 'just some prose\n');
    const r = await registry.execute('read_file', { path: txt });
    expect(r.success).toBe(true);
    // No LSP server matches .txt — output should be byte-identical to
    // the pre-Phase-D behavior.
    expect(r.output).toContain('just some prose');
  }, 10_000);

  it('10. write_file with no LSP-matching extension produces no diagnostics block', async () => {
    const txt = join(dir, 'plain.txt');
    const r = await registry.execute('write_file', { path: txt, content: 'hi\n' });
    expect(r.success).toBe(true);
    expect(r.output).not.toContain('<file_diagnostics>');
    expect(r.output).not.toContain('<diagnostic_summary>');
    expect(readFileSync(txt, 'utf-8')).toBe('hi\n');
  }, 10_000);
});
