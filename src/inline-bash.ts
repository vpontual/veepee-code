import { execSync } from 'child_process';

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
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, output: truncateOutput(output), exitCode: 0 };
  } catch (err: any) {
    const stderr = (err.stderr ?? '').toString();
    const stdout = (err.stdout ?? '').toString();
    const output = stderr || stdout || err.message || '';
    return { ok: false, output: truncateOutput(output), exitCode: err.status ?? 1 };
  }
}

const MAX_BYTES = 8 * 1024;
const MAX_LINES = 200;

export function truncateOutput(raw: string): string {
  if (!raw) return '';
  let out = raw;
  if (out.length > MAX_BYTES) {
    out = out.slice(0, MAX_BYTES) + `\n…[truncated at ${MAX_BYTES} bytes]`;
  }
  const lines = out.split('\n');
  if (lines.length > MAX_LINES) {
    out = lines.slice(0, MAX_LINES).join('\n') + `\n…[truncated at ${MAX_LINES} lines]`;
  }
  return out.replace(/\s+$/, '');
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
