import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { spawnSync } from 'child_process';
import { enableOsSandbox, disableOsSandbox, shellInvocation } from '../src/tools/os-sandbox.js';

const haveBwrap = spawnSync('bwrap', ['--ro-bind', '/', '/', 'true'], { stdio: 'ignore' }).status === 0;
afterEach(() => disableOsSandbox());

function run(command: string, cwd: string) {
  const { file, args } = shellInvocation(command, cwd);
  return spawnSync(file, args, { cwd, encoding: 'utf-8' });
}

describe.skipIf(!haveBwrap)('OS sandbox (bubblewrap)', () => {
  it('writes inside the project and /tmp, refuses writes elsewhere, and reads anything', () => {
    const proj = mkdtempSync(join(tmpdir(), 'sbx-proj-'));
    const outside = join(homedir(), `.vcode-sandbox-probe-${process.pid}`);
    expect(enableOsSandbox(proj)).toBe('on');
    expect(run('echo hi > inside.txt && cat inside.txt', proj).stdout.trim()).toBe('hi');
    const denied = run(`touch ${outside}`, proj);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toMatch(/Read-only file system/);
    expect(existsSync(outside)).toBe(false);
    expect(run('head -c 5 /etc/hostname >/dev/null && echo readable', proj).stdout.trim()).toBe('readable');
    rmSync(proj, { recursive: true, force: true });
  });

  it('runs plain bash when off', () => {
    disableOsSandbox();
    expect(shellInvocation('true', '/tmp').file).toBe('bash');
  });

  it('respects VCODE_NO_OS_SANDBOX=1', () => {
    process.env.VCODE_NO_OS_SANDBOX = '1';
    try { expect(enableOsSandbox('/tmp')).toBe('disabled'); } finally { delete process.env.VCODE_NO_OS_SANDBOX; }
  });
});
