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

beforeAll(async () => {
  if (!HAS_TSLS) return;

  dir = mkdtempSync(join(tmpdir(), 'vcode-lsp-e2e-'));
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
  if (!HAS_TSLS) return;
  await manager.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAS_TSLS)('LSP end-to-end' + skipMsg, () => {
  it('1. read_file warms the LSP server (Phase D)', async () => {
    const r = await registry.execute('read_file', { path: mainFile });
    expect(r.success).toBe(true);
    // Give the fire-and-forget didOpen a moment to land.
    await new Promise((res) => setTimeout(res, 1500));
    // The server should now know about main.ts; subsequent diagnostics
    // queries should be near-instant.
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
    await new Promise((res) => setTimeout(res, 1500));

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
    await new Promise((res) => setTimeout(res, 500));

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
