import { writeFile, mkdir } from 'fs/promises';
import { resolve, isAbsolute, relative } from 'path';
import { existsSync, readFileSync } from 'fs';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

/** Split on shell separators so `ls; rm -rf /` is inspected segment by segment. */
function segments(command: string): string[] {
  return command.split(/[;&|]+|\n/);
}

/** Collect flags in a segment. `-fdx` contributes f, d and x; `--force-with-lease=x`
 *  contributes `force-with-lease`. Bundled short flags are why matching a literal
 *  `-rf` misses `-fr`. */
function flagSet(segment: string): { shorts: Set<string>; longs: Set<string> } {
  const shorts = new Set<string>();
  const longs = new Set<string>();
  for (const raw of segment.split(/\s+/)) {
    const tok = raw.split('=')[0];
    if (/^--[a-zA-Z][\w-]*$/.test(tok)) longs.add(tok.slice(2));
    else if (/^-[a-zA-Z]+$/.test(tok)) for (const ch of tok.slice(1)) shorts.add(ch);
  }
  return { shorts, longs };
}

/** Recursive delete in any spelling: `rm -rf`, `rm -fr`, `rm -r -f`,
 *  `rm --recursive`. The old `/\brm\s+-rf?\b/` matched only the first. */
export function isRecursiveRm(command: string): boolean {
  for (const seg of segments(command)) {
    const m = /\brm\b/.exec(seg);
    if (!m) continue;
    const { shorts, longs } = flagSet(seg.slice(m.index));
    if (shorts.has('r') || shorts.has('R') || longs.has('recursive')) return true;
  }
  return false;
}

/** Force push in any spelling: `-f`, `--force`, `--force-with-lease`.
 *  The old `/push\s+.*--force/` missed the short flag entirely. */
export function isForcePush(command: string): boolean {
  for (const seg of segments(command)) {
    if (!/\bgit\b.*\bpush\b/.test(seg)) continue;
    const { shorts, longs } = flagSet(seg);
    if (shorts.has('f')) return true;
    for (const l of longs) {
      if (l === 'force' || l === 'force-with-lease' || l === 'force-if-includes') return true;
    }
  }
  return false;
}

/** `git clean` with force — deletes untracked files (including .env). */
export function isGitClean(command: string): boolean {
  for (const seg of segments(command)) {
    if (!/\bgit\b.*\bclean\b/.test(seg)) continue;
    const { shorts, longs } = flagSet(seg);
    if (shorts.has('f') || longs.has('force')) return true;
  }
  return false;
}

/** Git flags that turn an otherwise read-only subcommand into code execution
 *  or a file write — `-c core.pager=<cmd> log` runs <cmd>. Their presence
 *  disqualifies the auto-allow path. */
const GIT_ESCAPE_FLAGS = /(^|\s)(-c|-O|--config-env|--output|--upload-pack|--receive-pack|--exec|--ext-diff)(=|\s|$)/;

// Prompt handler — can be replaced by TUI's promptPermission
type PromptHandler = (toolName: string, args: Record<string, unknown>, reason?: string, preview?: string) => Promise<string>;

export class PermissionManager {
  private alwaysAllowed = new Set<string>();
  private sessionAllowed = new Set<string>();
  private projectAllowed = new Set<string>(); // tool:project pairs (e.g., "write_file:/home/user/myproject")
  private configPath: string;
  private promptHandler: PromptHandler | null = null;

  // Tools considered safe and auto-allowed (read-only operations).
  // NOTE: `git` is deliberately NOT here — it accepts arbitrary subcommands,
  // and blanket-allowing it means `git push -f` and `git clean -fdx` run with
  // no prompt. Read-only git subcommands are auto-allowed via SAFE_GIT_SUBCOMMANDS.
  private static SAFE_TOOLS = new Set([
    'read_file',
    'list_files',
    'glob',
    'grep',
    'weather',
    'system_info',
    'news',
  ]);

  /** Git subcommands with no write form — auto-allowed so routine inspection
   *  (status/diff/log) stays friction-free. Anything not listed prompts.
   *  Deliberately excludes subcommands with destructive modes even though
   *  they're usually read-only: branch (-D), tag (-d), stash (drop/clear),
   *  remote (remove), config (set), reflog (delete/expire), notes, bisect. */
  private static SAFE_GIT_SUBCOMMANDS = new Set([
    'status', 'log', 'diff', 'show', 'blame', 'shortlog', 'whatchanged',
    'rev-parse', 'rev-list', 'describe', 'ls-files', 'ls-remote', 'ls-tree',
    'merge-base', 'name-rev', 'cat-file', 'count-objects', 'grep', 'annotate',
    'verify-commit', 'check-ignore', 'diff-tree', 'symbolic-ref',
  ]);

  // Dangerous args patterns that should always prompt.
  //
  // This list is the ONLY check that survives an "always"/"session" grant —
  // check() consults it before alwaysAllowed/sessionAllowed — so anything that
  // can destroy work or publish history must be caught here, and the matchers
  // must not be trivially evadable by an equivalent spelling (`rm -fr`, `-f`).
  private static DANGEROUS_PATTERNS: Array<{ tool: string; check: (args: Record<string, unknown>) => boolean; reason: string }> = [
    { tool: 'bash', check: (a) => isRecursiveRm(String(a.command || '')), reason: 'destructive delete' },
    { tool: 'bash', check: (a) => isForcePush(String(a.command || '')), reason: 'force push' },
    { tool: 'bash', check: (a) => /\bgit\s+reset\s+--hard\b/.test(String(a.command || '')), reason: 'hard reset' },
    { tool: 'bash', check: (a) => isGitClean(String(a.command || '')), reason: 'delete untracked files' },
    { tool: 'bash', check: (a) => /\bdocker\s+(rm|rmi|system\s+prune)/.test(String(a.command || '')), reason: 'docker cleanup' },
    { tool: 'bash', check: (a) => /\b(mkfs\S*|shred)\b/.test(String(a.command || '')), reason: 'destroys data' },
    { tool: 'bash', check: (a) => /\bdd\b[^;&|]*\bof=/.test(String(a.command || '')), reason: 'raw disk write' },

    { tool: 'git', check: (a) => isForcePush('git ' + String(a.args || '')), reason: 'force push' },
    { tool: 'git', check: (a) => /(^|\s)reset\s+--hard\b/.test(String(a.args || '')), reason: 'hard reset' },
    { tool: 'git', check: (a) => isGitClean('git ' + String(a.args || '')), reason: 'delete untracked files' },
    { tool: 'git', check: (a) => /(^|\s)(checkout|restore)\s+(--\s+)?\.(\s|$)/.test(String(a.args || '')), reason: 'discard local changes' },
    { tool: 'git', check: (a) => /(^|\s)branch\s+(-D|-d|--delete)\b/.test(String(a.args || '')), reason: 'delete branch' },
    { tool: 'git', check: (a) => /(^|\s)tag\s+(-d|--delete)\b/.test(String(a.args || '')), reason: 'delete tag' },
    { tool: 'git', check: (a) => /(^|\s)stash\s+(drop|clear)\b/.test(String(a.args || '')), reason: 'discard stashed work' },
    { tool: 'git', check: (a) => /(^|\s)(filter-branch|filter-repo)\b/.test(String(a.args || '')), reason: 'rewrites history' },
    { tool: 'git', check: (a) => /(^|\s)reflog\s+(delete|expire)\b/.test(String(a.args || '')), reason: 'destroys recovery log' },
  ];

  /** True when the git args are an unambiguously read-only invocation.
   *
   *  The subcommand must be the FIRST token. Leading global options are not
   *  tolerated because several of them execute code — `git -c core.pager='sh
   *  -c ...' log` would otherwise sail through as "just a log". The git tool
   *  takes a `cwd` argument, so `-C <dir>` isn't needed for normal use. */
  static isReadOnlyGit(args: Record<string, unknown>): boolean {
    const raw = String(args.args ?? '').trim();
    if (!raw) return false;
    if (GIT_ESCAPE_FLAGS.test(' ' + raw)) return false;
    const sub = raw.split(/\s+/)[0];
    return PermissionManager.SAFE_GIT_SUBCOMMANDS.has(sub);
  }

  constructor() {
    this.configPath = resolve(process.env.HOME || '~', '.veepee-code', 'permissions.json');
    this.loadPersisted();
  }

  /** Load saved grants. Synchronous by design: the constructor cannot await,
   *  and an async read left a window where check() ran against empty sets and
   *  re-prompted for tools the user had already allowed permanently. The file
   *  is a few hundred bytes. */
  private loadPersisted(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf-8')) as {
        alwaysAllowed?: string[];
        projectAllowed?: string[];
      };
      for (const tool of parsed.alwaysAllowed ?? []) this.alwaysAllowed.add(tool);
      for (const entry of parsed.projectAllowed ?? []) this.projectAllowed.add(entry);
    } catch {
      // Ignore corrupt file
    }
  }

  /** Set a custom prompt handler (used by TUI) */
  setPromptHandler(handler: PromptHandler): void {
    this.promptHandler = handler;
  }

  /** The handler currently installed, so a mode that swaps in its own (goal
   *  mode auto-allows, since there is nobody watching) can put back exactly
   *  what was there rather than guessing at the default. */
  getPromptHandler(): PromptHandler | null {
    return this.promptHandler;
  }

  /** For backwards compat — unused with TUI but needed for API mode */
  setReadline(_rl: unknown): void {
    // no-op when TUI is handling prompts
  }

  /** Check if a tool call is allowed, prompting the user if needed.
   *  `preview` is an optional formatted diff/summary surfaced in the prompt
   *  so the user can decide knowing what's about to change. Caller computes
   *  the preview (e.g. unified diff for edit_file/write_file) — keeps this
   *  module agnostic of tool semantics. */
  async check(toolName: string, args: Record<string, unknown>, preview?: string): Promise<PermissionDecision> {
    const dangerous = PermissionManager.DANGEROUS_PATTERNS.find(
      p => p.tool === toolName && p.check(args)
    );
    if (dangerous) {
      return this.prompt(toolName, args, dangerous.reason, preview);
    }

    if (PermissionManager.SAFE_TOOLS.has(toolName)) {
      return 'allow';
    }

    // Read-only git (status/diff/log/...) stays friction-free; every other
    // git subcommand goes through the normal prompt path.
    if (toolName === 'git' && PermissionManager.isReadOnlyGit(args)) {
      return 'allow';
    }

    if (this.alwaysAllowed.has(toolName) || this.sessionAllowed.has(toolName)) {
      return 'allow';
    }

    // Check project-scoped permission (tool allowed for files in this project)
    const filePathRaw = typeof args.path === 'string' ? args.path
      : typeof args.file === 'string' ? args.file : null;
    if (filePathRaw) {
      const filePath = isAbsolute(filePathRaw) ? filePathRaw : resolve(process.cwd(), filePathRaw);
      for (const entry of this.projectAllowed) {
        const sep = entry.indexOf(':');
        if (sep <= 0) continue;
        const tool = entry.slice(0, sep);
        const projectDir = entry.slice(sep + 1);
        const rel = relative(projectDir, filePath);
        const inProject = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
        if (tool === toolName && inProject) {
          return 'allow';
        }
      }
    }

    return this.prompt(toolName, args, undefined, preview);
  }

  private async prompt(toolName: string, args: Record<string, unknown>, reason?: string, preview?: string): Promise<PermissionDecision> {
    if (!this.promptHandler) {
      // Fail closed. Every real entry point installs a handler and states its
      // policy explicitly — `-p` sets auto-approve, `--serve` sets deny, the
      // TUI prompts — and callers that want no gate at all pass
      // permissionMode: 'auto_allow', which bypasses check() entirely. So a
      // missing handler means an entry point forgot, and the safe answer to
      // "nobody can be asked" is no, not yes.
      return 'deny';
    }

    const answer = await this.promptHandler(toolName, args, reason, preview);
    const choice = answer.trim().toLowerCase();

    if (choice === 'y' || choice === 'yes') {
      return 'allow';
    }

    if (choice === 's' || choice === 'session') {
      this.sessionAllowed.add(toolName);
      return 'allow';
    }

    if (choice === 'a' || choice === 'always') {
      this.alwaysAllowed.add(toolName);
      await this.savePersisted();
      return 'allow_always';
    }

    if (choice === 'p' || choice === 'project') {
      const cwd = process.cwd();
      this.projectAllowed.add(`${toolName}:${cwd}`);
      await this.savePersisted();
      return 'allow';
    }

    return 'deny';
  }

  revoke(toolName: string): boolean {
    const had = this.alwaysAllowed.delete(toolName);
    this.sessionAllowed.delete(toolName);
    if (had) this.savePersisted();
    return had;
  }

  resetSession(): void {
    this.sessionAllowed.clear();
  }

  resetAll(): void {
    this.sessionAllowed.clear();
    this.alwaysAllowed.clear();
    this.savePersisted();
  }

  listPermissions(): { alwaysAllowed: string[]; sessionAllowed: string[]; safeTools: string[] } {
    return {
      alwaysAllowed: Array.from(this.alwaysAllowed).sort(),
      sessionAllowed: Array.from(this.sessionAllowed).sort(),
      safeTools: Array.from(PermissionManager.SAFE_TOOLS).sort(),
    };
  }

  private async savePersisted(): Promise<void> {
    try {
      const dir = resolve(this.configPath, '..');
      await mkdir(dir, { recursive: true });
      await writeFile(this.configPath, JSON.stringify({
        alwaysAllowed: Array.from(this.alwaysAllowed).sort(),
        projectAllowed: Array.from(this.projectAllowed).sort(),
      }, null, 2));
    } catch {
      // Non-critical failure
    }
  }
}
