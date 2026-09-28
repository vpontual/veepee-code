/**
 * Background shell commands: `bash` with run_in_background, `bash_output`,
 * `kill_shell`.
 *
 * Real work needs a dev server, a watcher or a long build running while the
 * agent does something else. A plain `bash` call blocks until the command
 * exits (or times out and is killed), so a server could not be started and
 * then tested. Same shape as Claude Code's background bash, which current
 * models are trained on.
 *
 * Each command runs in its own process group so `kill_shell` stops everything
 * it spawned. Output is kept in a bounded buffer; `bash_output` returns only
 * what arrived since the previous read. Everything still running is killed
 * when vcode exits.
 */
import { spawn } from 'child_process';
import { resolve } from 'path';
import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { shellInvocation } from './os-sandbox.js';

/** Output kept per command; older output is dropped (and counted) past this. */
const MAX_BUFFER = 256 * 1024;
/** Output returned by one bash_output call. */
const MAX_READ = 32 * 1024;

interface Shell {
  id: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  startedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Output in arrival order (stdout and stderr interleaved). */
  buf: string;
  /** Characters dropped from the front of buf (for read offsets). */
  dropped: number;
  /** Absolute offset of the next unread character. */
  readTo: number;
}

const shells = new Map<string, Shell>();
let nextId = 1;

function append(s: Shell, text: string): void {
  s.buf += text;
  if (s.buf.length > MAX_BUFFER) {
    const cut = s.buf.length - MAX_BUFFER;
    s.buf = s.buf.slice(cut);
    s.dropped += cut;
  }
}

function killGroup(s: Shell, signal: NodeJS.Signals): void {
  try {
    if (s.pid !== undefined) process.kill(-s.pid, signal);
  } catch { /* already gone */ }
}

function running(s: Shell): boolean {
  return s.exitCode === null && s.signal === null;
}

/** Does anything in the command's process group still exist? A command that
 *  exited can leave children behind in its group (`server &`, a daemonising
 *  script), and those are what kill_shell and exit cleanup are for. */
function groupAlive(s: Shell): boolean {
  if (s.pid === undefined) return false;
  try { process.kill(-s.pid, 0); return true; } catch { return false; }
}

function status(s: Shell): string {
  const secs = Math.round((Date.now() - s.startedAt) / 1000);
  if (running(s)) return `running (${secs}s)`;
  if (groupAlive(s)) return `exited with code ${s.exitCode}, but processes it started are still running (kill_shell stops them)`;
  return s.signal ? `killed by ${s.signal}` : `exited with code ${s.exitCode}`;
}

let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // A dev server left behind after vcode exits keeps its port and its CPU.
  process.on('exit', () => {
    for (const s of shells.values()) if (running(s) || groupAlive(s)) killGroup(s, 'SIGKILL');
  });
}

/** Is anything in the process group led by `pid` still alive? */
export function processGroupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

/**
 * Track processes a finished blocking `bash` call left running (started with
 * `&` inside it). Their output went to that call, not here; what this adds is
 * a handle to stop them and the guarantee they are killed when vcode exits.
 */
export function adoptBackground(command: string, cwd: string, pid: number): string {
  installExitHook();
  const id = `bg${nextId++}`;
  shells.set(id, {
    id, command, cwd, pid, startedAt: Date.now(), exitCode: 0, signal: null,
    buf: '(started by a bash call; its output was returned there)\n', dropped: 0, readTo: 0,
  });
  return id;
}

/** Start a command in the background; returns immediately. */
export function startBackground(command: string, cwdParam?: string): ToolResult {
  installExitHook();
  const cwd = resolve(cwdParam || process.cwd());
  const id = `bg${nextId++}`;
  // Models add a trailing `&` out of habit. It makes bash exit at once and
  // leaves the real process orphaned, so status reads "exited 0" while the
  // server runs on. This call already backgrounds the command.
  command = command.replace(/\s*&\s*$/, '');
  const sh = shellInvocation(command, cwd);
  const child = spawn(sh.file, sh.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env },
  });
  const s: Shell = { id, command, cwd, pid: child.pid, startedAt: Date.now(), exitCode: null, signal: null, buf: '', dropped: 0, readTo: 0 };
  shells.set(id, s);
  child.stdout.on('data', (d: Buffer) => append(s, d.toString()));
  child.stderr.on('data', (d: Buffer) => append(s, d.toString()));
  child.on('exit', (code, signal) => { s.exitCode = code; s.signal = signal; });
  child.on('error', (err) => { append(s, `\n[failed to start: ${err.message}]\n`); s.exitCode = -1; });
  return ok(`Started ${id} in the background (pid ${child.pid ?? '?'}): ${command}\nCheck it with bash_output(id: "${id}"); stop it with kill_shell(id: "${id}").`);
}

export function buildBashOutputTool(): ToolDef {
  return {
    name: 'bash_output',
    description: 'Read new output from a background command started with bash(run_in_background: true), and whether it is still running. Returns only output produced since your last read. Omit id to list all background commands.',
    schema: z.object({
      id: z.string().optional().describe('The background command id, e.g. "bg1"'),
      filter: z.string().optional().describe('Optional regex: return only matching lines'),
    }),
    source: 'local',
    timeoutMs: 5_000,
    execute: async (params) => {
      const id = params.id as string | undefined;
      if (!id) {
        if (shells.size === 0) return ok('No background commands.');
        return ok([...shells.values()].map(s => `${s.id}  ${status(s)}  ${s.command}`).join('\n'));
      }
      const s = shells.get(id);
      if (!s) return fail(`No background command "${id}". Call bash_output with no id to list them.`);
      const start = Math.max(s.readTo - s.dropped, 0);
      const lost = s.readTo < s.dropped ? s.dropped - s.readTo : 0;
      let text = s.buf.slice(start);
      s.readTo = s.dropped + s.buf.length;
      if (params.filter) {
        let re: RegExp;
        try { re = new RegExp(String(params.filter)); } catch (e) { return fail(`Invalid filter regex: ${(e as Error).message}`); }
        text = text.split('\n').filter(l => re.test(l)).join('\n');
      }
      if (text.length > MAX_READ) text = `[… ${text.length - MAX_READ} earlier characters not shown …]\n` + text.slice(-MAX_READ);
      const head = `${s.id}: ${status(s)}${lost ? ` — ${lost} characters of output were dropped before this read` : ''}`;
      return ok(`${head}\n${text.trim() ? text : '(no new output)'}`);
    },
  };
}

export function buildKillShellTool(): ToolDef {
  return {
    name: 'kill_shell',
    description: 'Stop a background command (and everything it started) by id.',
    schema: z.object({ id: z.string().describe('The background command id, e.g. "bg1"') }),
    source: 'local',
    timeoutMs: 10_000,
    execute: async (params) => {
      const s = shells.get(String(params.id));
      if (!s) return fail(`No background command "${params.id}".`);
      if (!running(s) && !groupAlive(s)) return ok(`${s.id} had already ${status(s)}.`);
      killGroup(s, 'SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      if (running(s) || groupAlive(s)) killGroup(s, 'SIGKILL');
      await new Promise(r => setTimeout(r, 200));
      return ok(`${s.id} stopped (${status(s)}).`);
    },
  };
}
