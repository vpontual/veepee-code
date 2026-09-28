/**
 * OS-level sandbox for shell commands in unattended runs (bubblewrap).
 *
 * Unattended modes (goal, --improve) approve ordinary work without asking, and
 * the dangerous-command denylist is pattern matching: `rm -rf` is caught,
 * `find ~ -delete` or a script that does the same is not. There, bash runs
 * inside bwrap: the whole filesystem is readable, but only the project, /tmp
 * and package-manager caches are writable, so a wrong command cannot damage
 * anything outside the work it was given. Network stays on (installs need it).
 *
 * The in-process file tools are already confined to the workspace; this covers
 * the one tool that can do anything.
 *
 * Linux only. If bwrap is missing or cannot create namespaces (some containers
 * and systemd sandboxes forbid them), commands run unsandboxed with one
 * warning — never a broken run. VCODE_NO_OS_SANDBOX=1 turns it off.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import os from 'os';

let writableRoot: string | null = null;
let available: boolean | null = null;
let warned = false;

function bwrapWorks(): boolean {
  if (available !== null) return available;
  if (process.platform !== 'linux') return (available = false);
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'], { stdio: 'ignore', timeout: 5_000 });
  return (available = probe.status === 0);
}

/**
 * Confine bash to `root` (plus /tmp and caches) from now on. Returns what
 * happened, for the caller to show once.
 */
export function enableOsSandbox(root: string): 'on' | 'unavailable' | 'disabled' {
  if (process.env.VCODE_NO_OS_SANDBOX === '1') return 'disabled';
  if (!bwrapWorks()) {
    if (!warned) {
      warned = true;
      process.stderr.write('[VEEPEE Code] warning: bubblewrap is not available here; unattended shell commands run unsandboxed.\n');
    }
    return 'unavailable';
  }
  writableRoot = resolve(root);
  return 'on';
}

export function disableOsSandbox(): void {
  writableRoot = null;
}

export function osSandboxRoot(): string | null {
  return writableRoot;
}

/** The program and arguments that run `command` — inside the sandbox when it is on. */
export function shellInvocation(command: string, cwd: string): { file: string; args: string[] } {
  if (!writableRoot) return { file: 'bash', args: ['-c', command] };
  const home = os.homedir();
  const binds: string[] = ['--bind', writableRoot, writableRoot, '--bind', '/tmp', '/tmp'];
  // Package managers and build tools write caches under $HOME; installs and
  // builds are ordinary work, so those stay writable.
  for (const d of ['.npm', '.cache', '.cargo', '.rustup', '.local/share/pnpm', 'go/pkg']) {
    const p = join(home, d);
    if (existsSync(p)) binds.push('--bind', p, p);
  }
  return {
    file: 'bwrap',
    args: [
      '--ro-bind', '/', '/',
      ...binds,
      '--dev', '/dev',
      '--proc', '/proc',
      '--die-with-parent',
      '--chdir', cwd,
      'bash', '-c', command,
    ],
  };
}
