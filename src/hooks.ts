/**
 * Hooks runtime — executes user-configured shell commands at lifecycle events.
 *
 * Hooks let users automate harness behavior without prompt-engineering the
 * model: e.g., "run `tsc --noEmit` after every edit_file", "block writes to
 * `production/`", "log every tool call". Each hook is a shell command; it
 * receives the event payload as JSON on stdin and its stdout is rendered as
 * a system message in the chat. A non-zero exit on PreToolUse aborts the
 * tool call (giving the user explicit control).
 *
 * Trust model: hooks from the global layer (~/.veepee-code/settings.json)
 * are trusted because the user wrote them. Hooks from project-level
 * settings (`.veepee/settings.json`, `.veepee/settings.local.json`) require
 * an explicit trust grant the first time vcode encounters them, because
 * cloning a hostile repo could otherwise execute arbitrary commands.
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import {
  type HooksConfig,
  type HookEntry,
  getConfigDir,
  readSettingsLayer,
  type SettingsLayer,
} from './config.js';

export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'Notification';

/** All known event names — used by /hooks listing and lint. */
export const HOOK_EVENTS: HookEventName[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'Notification',
];

export interface HookExecResult {
  /** Stdout from the hook (may be shown to user). */
  stdout: string;
  /** Stderr (logged but generally not shown). */
  stderr: string;
  /** Exit code; non-zero on PreToolUse blocks the tool call. */
  exitCode: number;
  /** Set if the hook was killed by the timeout. */
  timedOut: boolean;
  /** The matched hook (for /hooks debug). */
  hook: HookEntry;
  /** Origin layer for trust attribution. */
  layer: SettingsLayer;
}

export interface PreToolUsePayload {
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
}
export interface PostToolUsePayload extends PreToolUsePayload {
  result: { success: boolean; output: string; error?: string };
  durationMs: number;
}
export interface UserPromptSubmitPayload {
  prompt: string;
  cwd: string;
}
export interface StopPayload {
  cwd: string;
  messageCount: number;
}
export interface NotificationPayload {
  kind: 'permission' | 'info' | 'warn';
  message: string;
}

type EventPayload =
  | PreToolUsePayload
  | PostToolUsePayload
  | UserPromptSubmitPayload
  | StopPayload
  | NotificationPayload;

const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Trust management ──────────────────────────────────────────────────

interface TrustedProjects {
  /** Map of absolute project path → ISO timestamp of grant. */
  trusted: Record<string, string>;
  /** Map of absolute project path → ISO timestamp of explicit denial. */
  denied: Record<string, string>;
}

function getTrustedProjectsPath(): string {
  return resolve(getConfigDir(), 'trusted-projects.json');
}

function loadTrustedProjects(): TrustedProjects {
  const path = getTrustedProjectsPath();
  if (!existsSync(path)) return { trusted: {}, denied: {} };
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      trusted: data.trusted ?? {},
      denied: data.denied ?? {},
    };
  } catch {
    return { trusted: {}, denied: {} };
  }
}

function saveTrustedProjects(state: TrustedProjects): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getTrustedProjectsPath(), JSON.stringify(state, null, 2) + '\n');
}

export type TrustState = 'trusted' | 'denied' | 'unknown';

export function getProjectTrustState(cwd: string = process.cwd()): TrustState {
  const state = loadTrustedProjects();
  const abs = resolve(cwd);
  if (state.trusted[abs]) return 'trusted';
  if (state.denied[abs]) return 'denied';
  return 'unknown';
}

export function setProjectTrust(cwd: string, decision: 'trust' | 'deny'): void {
  const state = loadTrustedProjects();
  const abs = resolve(cwd);
  const now = new Date().toISOString();
  if (decision === 'trust') {
    state.trusted[abs] = now;
    delete state.denied[abs];
  } else {
    state.denied[abs] = now;
    delete state.trusted[abs];
  }
  saveTrustedProjects(state);
}

/** Returns true if project/local layers actually have any hooks defined.
 *  Used by the trust prompt — no hooks → no need to ask. */
export function projectHasHooks(cwd: string = process.cwd()): boolean {
  for (const layer of ['project', 'local'] as SettingsLayer[]) {
    const cfg = readSettingsLayer(layer, cwd);
    if (cfg.hooks && Object.keys(cfg.hooks).length > 0) return true;
  }
  return false;
}

// ─── Matcher ───────────────────────────────────────────────────────────

/** Matchers are regex patterns applied to the event subject. Anchoring is
 *  the user's responsibility (e.g. `^Bash$` for exact match, `^Bash` for
 *  prefix). Invalid patterns are treated as literal strings (safe fallback).
 *  No matcher → matches everything. */
function matcherFires(matcher: string | undefined, subject: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(subject);
  } catch {
    return matcher === subject; // bad regex falls back to literal equality
  }
}

function eventSubject(event: HookEventName, payload: EventPayload): string {
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
      return (payload as PreToolUsePayload).tool;
    case 'UserPromptSubmit':
      return (payload as UserPromptSubmitPayload).prompt;
    case 'Stop':
      return '';
    case 'Notification':
      return (payload as NotificationPayload).kind;
  }
}

// ─── Layered hook collection ───────────────────────────────────────────

interface HookWithOrigin {
  hook: HookEntry;
  layer: SettingsLayer;
}

/** Gather hooks for a given event from all layers, in execution order
 *  (global → project → local). Trust filtering is done by the caller using
 *  the layer field. */
export function collectHooks(
  event: HookEventName,
  cwd: string = process.cwd(),
): HookWithOrigin[] {
  const out: HookWithOrigin[] = [];
  for (const layer of ['global', 'project', 'local'] as SettingsLayer[]) {
    const cfg = readSettingsLayer(layer, cwd);
    const hooks: HooksConfig | null | undefined = cfg.hooks;
    const entries = hooks?.[event];
    if (!entries) continue;
    for (const hook of entries) out.push({ hook, layer });
  }
  return out;
}

// ─── Execution ─────────────────────────────────────────────────────────

function execHook(hook: HookEntry, layer: SettingsLayer, payload: EventPayload): Promise<HookExecResult> {
  return new Promise((resolveP) => {
    const timeout = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('bash', ['-c', hook.command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, VEEPEE_HOOK_LAYER: layer },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolveP({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
        timedOut,
        hook,
        layer,
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolveP({
        stdout: '',
        stderr: `hook failed to spawn: ${err.message}`,
        exitCode: 1,
        timedOut: false,
        hook,
        layer,
      });
    });

    // Send event payload as JSON on stdin
    try {
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    } catch {
      // Process already gone — ignore.
    }
  });
}

/** Run all matching hooks for an event in order (global → project → local).
 *  Project/local hooks are skipped silently when the project isn't trusted.
 *  Returns the exec results in the same order so callers can decide what to
 *  do (e.g. block the action on PreToolUse non-zero exit). */
export async function runHooks(
  event: HookEventName,
  payload: EventPayload,
  options: { cwd?: string } = {},
): Promise<HookExecResult[]> {
  const cwd = options.cwd ?? process.cwd();
  const trust = getProjectTrustState(cwd);
  const collected = collectHooks(event, cwd);

  const subject = eventSubject(event, payload);
  const filtered: HookWithOrigin[] = [];
  for (const item of collected) {
    // Project/local require trust
    if (item.layer !== 'global' && trust !== 'trusted') continue;
    if (!matcherFires(item.hook.matcher, subject)) continue;
    filtered.push(item);
  }

  const results: HookExecResult[] = [];
  for (const { hook, layer } of filtered) {
    const r = await execHook(hook, layer, payload);
    results.push(r);
  }
  return results;
}

/** Convenience: returns true if any PreToolUse hook returned non-zero
 *  (used by the agent to abort the tool call). */
export function shouldBlock(results: HookExecResult[]): { blocked: boolean; reason?: string } {
  for (const r of results) {
    if (r.exitCode !== 0) {
      const reason = r.stdout || r.stderr || `Hook exited with code ${r.exitCode}`;
      return { blocked: true, reason: `[hook] ${reason}` };
    }
  }
  return { blocked: false };
}
