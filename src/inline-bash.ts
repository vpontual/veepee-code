import { spawnSync } from 'child_process';

export type BangKind = 'silent' | 'send' | null;

export interface BangParse {
  kind: BangKind;
  cmd: string;
}

/**
 * Parse a user-submitted line for the `!cmd` / `!!cmd` inline-bash syntax.
 *
 * - `!!cmd` → run, do not send output to LLM (silent).
 * - `!cmd`  → run, send output to LLM as the next user message (send).
 * - `! cmd` (with space) → not bang; pass through. A leading bang followed by
 *   whitespace looks more like prose than a shell escape.
 *
 * Returns `{ kind: null, cmd: '' }` for non-bang inputs so callers can
 * unconditionally call this and switch on `kind`.
 */
export function parseBang(input: string): BangParse {
  const trimmed = input.trim();
  if (trimmed.startsWith('!!')) {
    return { kind: 'silent', cmd: trimmed.slice(2).trim() };
  }
  if (trimmed.startsWith('!') && !trimmed.startsWith('! ')) {
    return { kind: 'send', cmd: trimmed.slice(1).trim() };
  }
  return { kind: null, cmd: '' };
}

export interface ShellResult {
  ok: boolean;
  output: string;
  exitCode: number;
}

/**
 * Run a shell command for inline-bash, capturing combined output. Mirrors the
 * existing `runShellCommand` semantics but returns the captured output for
 * callers that want to forward it to the LLM. Cap output at 8 KiB / 200 lines
 * — anything larger gets truncated with a tail marker, matching the bash tool.
 */
export function runInlineShell(cmd: string, cwd: string = process.cwd()): ShellResult {
  // spawnSync rather than execSync so stderr is available on SUCCESS too:
  // execSync returns stdout only, so a command that succeeded while warning
  // (deprecation notices, tsc warnings) silently lost everything it wrote to
  // stderr — exactly the output the user ran `!cmd` to see.
  const r = spawnSync('bash', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (r.error) {
    return { ok: false, output: truncateOutput(r.error.message), exitCode: 1 };
  }

  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  const combined = stdout + (stderr.trim() ? `${stdout.endsWith('\n') || !stdout ? '' : '\n'}[stderr]\n${stderr}` : '');
  const ok = r.status === 0;
  return {
    ok,
    output: truncateOutput(combined || (ok ? '' : `exited with status ${r.status ?? 'unknown'}`)),
    exitCode: r.status ?? 1,
  };
}

const MAX_BYTES = 8 * 1024;
const MAX_LINES = 200;

export function truncateOutput(raw: string): string {
  if (!raw) return '';
  let out = raw;
  const reasons: string[] = [];

  if (out.length > MAX_BYTES) {
    out = out.slice(0, MAX_BYTES);
    reasons.push(`${MAX_BYTES} bytes`);
  }
  const lines = out.split('\n');
  if (lines.length > MAX_LINES) {
    out = lines.slice(0, MAX_LINES).join('\n');
    reasons.push(`${MAX_LINES} lines`);
  }

  out = out.replace(/\s+$/, '');
  // One marker, appended LAST. Appending the byte marker before the line cap
  // let the line trim cut it back off, so truncated output looked complete.
  if (reasons.length > 0) out += `\n…[truncated at ${reasons.join(' / ')}]`;
  return out;
}

/**
 * Wrap a shell run for inclusion in the LLM message stream. Format matches
 * the convention used by user-pasted bash output — keeps the LLM from
 * confusing it with arbitrary user text.
 */
export function formatShellForLlm(cmd: string, result: ShellResult): string {
  const status = result.ok ? '' : ` (exit ${result.exitCode})`;
  const body = result.output || '(no output)';
  return `[shell]${status} $ ${cmd}\n${body}\n[/shell]`;
}
