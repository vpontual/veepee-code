import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LspManager } from '../src/lsp/manager.js';
import { notifyLSPs } from '../src/lsp/manager.js';
import { LspClient } from '../src/lsp/client.js';
import { pathToFileUri } from '../src/lsp/uri.js';
import { formatDiagnostics } from '../src/lsp/diagnostics.js';

const TSLS_PATH = resolve('node_modules/.bin/typescript-language-server');
const HAS_TSLS = existsSync(TSLS_PATH);

const skipMsg = HAS_TSLS ? '' : ' (skipped — typescript-language-server not installed in node_modules)';

let tmpDir: string | null = null;
let activeClient: LspClient | null = null;
let activeManager: LspManager | null = null;

afterEach(async () => {
  if (activeClient) {
    try { await activeClient.shutdown(); } catch { /* swallow */ }
    activeClient = null;
  }
  if (activeManager) {
    try { await activeManager.shutdown(); } catch { /* swallow */ }
    activeManager = null;
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function makeTempProject(content: string): { dir: string; file: string } {
  tmpDir = mkdtempSync(join(tmpdir(), 'vcode-lsp-int-'));
  const file = join(tmpDir, 'broken.ts');
  writeFileSync(file, content);
  writeFileSync(join(tmpDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, target: 'es2022',
      module: 'esnext', moduleResolution: 'bundler',
    },
    include: ['*.ts'],
  }));
  return { dir: tmpDir, file };
}

describe.skipIf(!HAS_TSLS)('LSP integration with typescript-language-server' + skipMsg, () => {
  it('LspClient.start returns diagnostics for a known type error', async () => {
    const { dir, file } = makeTempProject('const n: number = "string";\n');

    activeClient = await LspClient.start('typescript', {
      command: TSLS_PATH,
      args: ['--stdio'],
      filetypes: ['ts', 'tsx'],
    }, pathToFileUri(dir));
    expect(activeClient.isAlive()).toBe(true);

    const uri = pathToFileUri(file);
    await activeClient.openFile(uri, 'typescript', 'const n: number = "string";\n');
    const diags = await activeClient.waitForDiagnostics(uri, 10_000);

    expect(diags.length).toBeGreaterThan(0);
    const messages = diags.map((d) => d.message).join(' | ');
    expect(messages).toMatch(/string|number|not assignable/i);
  }, 30_000);

  it('LspManager lazy-starts the matching client by file extension', async () => {
    const { dir, file } = makeTempProject('const x: number = "broken";\n');

    activeManager = new LspManager({
      typescript: {
        command: TSLS_PATH,
        args: ['--stdio'],
        filetypes: ['ts', 'tsx'],
      },
    }, dir);
    expect(activeManager.runningLabels()).toEqual([]);

    const client = await activeManager.getClientForFile(file);
    expect(client).not.toBeNull();
    expect(activeManager.runningLabels()).toEqual(['typescript']);

    await notifyLSPs(activeManager, file);

    const all = activeManager.getAllDiagnostics();
    expect(all.size).toBeGreaterThan(0);

    const block = formatDiagnostics(all, file, dir);
    expect(block).toContain('<file_diagnostics>');
    expect(block).toContain('Error:');
    expect(block).toContain('<diagnostic_summary>');
  }, 30_000);

  it('LspManager.matchByPath returns null for an unconfigured extension', () => {
    activeManager = new LspManager({
      typescript: { command: 'typescript-language-server', args: ['--stdio'], filetypes: ['ts'] },
    }, '/tmp');
    expect(activeManager.matchByPath('/tmp/main.go')).toBeNull();
    expect(activeManager.matchByPath('/tmp/x.ts')).toBe('typescript');
  });

  it('LspManager.shutdown is idempotent and safe to call after no-op', async () => {
    activeManager = new LspManager(null, '/tmp');
    await activeManager.shutdown();
    await activeManager.shutdown(); // second call should be a no-op
  });
});
