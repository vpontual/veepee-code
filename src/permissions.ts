import { writeFile, mkdir } from 'fs/promises';
import { resolve, isAbsolute, relative } from 'path';
import { existsSync, readFileSync } from 'fs';
import { whileBlocked } from './agentstate.js';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

/**
 * How much the user wants to be asked. Cycled with Shift+Tab.
 *
 * Modelled on Claude Code's ring, with one deliberate difference noted below.
 *
 *  manual       — ask before anything that is not read-only. The default.
 *  accept_edits — file edits go through; bash and everything else still ask.
 *                 Edits are reviewable after the fact (checkpoints, git); a
 *                 shell command is not.
 *  plan         — mutations are REFUSED, with a reason the model can read.
 *                 Not by hiding the tools: vcode used to filter them out of the
 *                 tool list, and the model, unable to see bash, silently
 *                 reproduced a script's output with ~50 read-only calls instead
 *                 of saying it could not run it. A refusal it can read is
 *                 recoverable; an absence is not.
 *  auto         — approve everything except the DANGEROUS_PATTERNS.
 *
 * On `auto`: Claude Code keeps full bypass OUT of the shift-tab ring and behind
 * a startup flag, on the reasoning that a keystroke away from "approve
 * everything" is how accidents happen. This ring includes it because it was
 * asked for, but the dangerous patterns — rm -rf, git push --force, git reset
 * --hard, docker rm/prune — still prompt. That is the line: auto removes
 * friction, it does not remove the guard on the handful of things that are not
 * undoable.
 */
export type PermissionPosture = 'manual' | 'accept_edits' | 'plan' | 'auto';

export const PERMISSION_POSTURES: PermissionPosture[] = ['manual', 'accept_edits', 'plan', 'auto'];

/** Short labels for the status bar. */
export const POSTURE_LABEL: Record<PermissionPosture, string> = {
  manual: 'manual',
  accept_edits: 'accept edits',
  plan: 'plan',
  auto: 'auto',
};

/** Next posture in the ring. */
export function nextPosture(current: PermissionPosture): PermissionPosture {
  const i = PERMISSION_POSTURES.indexOf(current);
  return PERMISSION_POSTURES[(i + 1) % PERMISSION_POSTURES.length];
}

/** Tools that change the workspace. */
export const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'notebook_edit']);

/** Tools plan mode refuses outright — edits plus anything that can run. */
export const PLAN_REFUSED_TOOLS = new Set([...EDIT_TOOLS, 'bash', 'shell']);

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

/**
 * Long-option matching that respects GIT'S PREFIX ABBREVIATION.
 *
 * Git accepts any UNAMBIGUOUS abbreviation of a long option, so `git branch --u`
 * IS `git branch --unset-upstream` — silently, exit 0, no warning. That is not a
 * hypothetical: on 2026-08-23 an agent asked only to REPORT sync state wrote
 * `upstream=$(git branch --u 2>/dev/null | ...)`, meaning "show me the upstream",
 * and wiped branch tracking in all 37 repos under ~/Dev. It then reported every
 * repo as "synced, zero ahead, zero behind" — because with tracking gone its own
 * `HEAD.."$upstream"` collapsed to `HEAD..HEAD` = 0, and `git status -sb` prints
 * a bare `## main` instead of `## main...origin/main [ahead 1]`, which its
 * verification step scored as clean. Matching the full spelling only would have
 * caught none of it.
 *
 * Over-matching is the SAFE direction here: an abbreviation that is ambiguous
 * makes git error out without doing anything, so the worst case of a loose match
 * is one extra prompt.
 */
function hasLongOptionPrefixOf(longs: Set<string>, ...fullNames: string[]): boolean {
  for (const flag of longs) {
    for (const full of fullNames) if (full.startsWith(flag)) return true;
  }
  return false;
}

/**
 * Commands that mutate repo CONFIGURATION rather than files.
 *
 * A distinct class from the destructive patterns above, and the reason it needs
 * its own guard: none of these delete anything, so none of them look dangerous —
 * they change what every LATER command means. Tracking, remotes and branch
 * pointers are the frame the rest of git is read through, so corrupting them
 * silently invalidates every subsequent measurement, including any check the
 * agent runs on its own work. See `hasLongOptionPrefixOf` for the incident.
 *
 * Covers: upstream tracking (`branch --unset-upstream` / `--set-upstream-to`),
 * config writes (`config --unset`, `config <key> <value>`, and git 2.46's
 * `config set|unset|rename-section|remove-section`), remote surgery
 * (`remote add|remove|rename|set-url|set-head|prune`), and force-repointing a
 * branch (`checkout -B`, `switch -C`), which moves a ref out from under work in
 * progress without touching a file.
 */
export function isGitConfigMutation(command: string): boolean {
  for (const seg of segments(command)) {
    const sub = gitSubcommand(seg);
    if (!sub) continue;
    const { shorts, longs } = flagSet(seg);

    // Upstream tracking. `git push -u` is deliberately NOT here: it is routine,
    // and it SETS tracking on a branch being published rather than removing it.
    if (sub === 'branch' && hasLongOptionPrefixOf(longs, 'unset-upstream', 'set-upstream-to')) return true;

    // Config writes. Read forms (--get*, --list, and git 2.46's `config get|list`)
    // are left alone; a `git config` with neither is a WRITE, since the plain
    // `git config user.email x` form takes no flag at all. So the test is the
    // ABSENCE of a read form, not the presence of a write one.
    if (sub === 'config') {
      const rest = gitSubcommandArgs(seg);
      const readFlag = hasLongOptionPrefixOf(longs, 'get', 'get-all', 'get-regexp', 'get-urlmatch', 'list')
        || shorts.has('l');
      const readSub = rest[0] === 'get' || rest[0] === 'list';
      if (rest.length > 0 && !readFlag && !readSub) return true;
    }

    // Remote surgery.
    if (sub === 'remote' && /^(add|remove|rm|rename|set-url|set-head|set-branches|prune)$/.test(gitSubcommandArgs(seg)[0] ?? '')) return true;

    // Force-repointing a branch: `-B` / `-C` MOVE an existing ref, unlike -b/-c
    // which refuse when the branch already exists.
    if (sub === 'checkout' && shorts.has('B')) return true;
    if (sub === 'switch' && shorts.has('C')) return true;
  }
  return false;
}

/** The git SUBCOMMAND in a segment — the first token that is neither a global
 *  option nor an option's argument. Matching a bare `\bconfig\b` instead would
 *  prompt on `git log src/config.ts`, which is how a guard earns its way into
 *  being switched off. Reads from the `git` token so it still finds the command
 *  inside `x=$(git branch --u)`. */
function gitSubcommand(seg: string): string | null {
  const toks = gitTokens(seg);
  return toks.length > 0 ? toks[0] : null;
}

/** Tokens after the subcommand, options stripped. */
function gitSubcommandArgs(seg: string): string[] {
  return gitTokens(seg).slice(1).filter(t => !t.startsWith('-'));
}

/** Tokens of a git invocation with global options (and their arguments) removed. */
function gitTokens(seg: string): string[] {
  const m = /\bgit\b/.exec(seg);
  if (!m) return [];
  const toks = seg.slice(m.index + 'git'.length).trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let started = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!started) {
      // Global options that consume the NEXT token: -C <path>, -c <name=value>.
      if (t === '-C' || t === '-c') { i++; continue; }
      if (t.startsWith('-')) continue;      // --git-dir=…, --no-pager, …
      started = true;
    }
    out.push(t);
  }
  return out;
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
    { tool: 'bash', check: (a) => isGitConfigMutation(String(a.command || '')), reason: 'changes git config/tracking' },

    { tool: 'git', check: (a) => isForcePush('git ' + String(a.args || '')), reason: 'force push' },
    { tool: 'git', check: (a) => /(^|\s)reset\s+--hard\b/.test(String(a.args || '')), reason: 'hard reset' },
    { tool: 'git', check: (a) => isGitClean('git ' + String(a.args || '')), reason: 'delete untracked files' },
    { tool: 'git', check: (a) => /(^|\s)(checkout|restore)\s+(--\s+)?\.(\s|$)/.test(String(a.args || '')), reason: 'discard local changes' },
    { tool: 'git', check: (a) => /(^|\s)branch\s+(-D|-d|--delete)\b/.test(String(a.args || '')), reason: 'delete branch' },
    { tool: 'git', check: (a) => /(^|\s)tag\s+(-d|--delete)\b/.test(String(a.args || '')), reason: 'delete tag' },
    { tool: 'git', check: (a) => /(^|\s)stash\s+(drop|clear)\b/.test(String(a.args || '')), reason: 'discard stashed work' },
    { tool: 'git', check: (a) => /(^|\s)(filter-branch|filter-repo)\b/.test(String(a.args || '')), reason: 'rewrites history' },
    { tool: 'git', check: (a) => /(^|\s)reflog\s+(delete|expire)\b/.test(String(a.args || '')), reason: 'destroys recovery log' },
    { tool: 'git', check: (a) => isGitConfigMutation('git ' + String(a.args || '')), reason: 'changes git config/tracking' },
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
  /**
   * Apply the posture, then fall through to the normal check.
   *
   * Dangerous patterns are evaluated FIRST and are never skipped, in any
   * posture including auto — those are the operations that cannot be undone by
   * a checkpoint or a git reset, so the one prompt they cost is worth it.
   *
   * Returns a refusal REASON for plan mode rather than a bare 'deny', so the
   * model is told why and can adjust — that is the whole difference between
   * this and the tool-filtering it replaces.
   */
  async checkWithPosture(
    posture: PermissionPosture,
    toolName: string,
    args: Record<string, unknown>,
    preview?: string,
  ): Promise<PermissionDecision | { decision: 'deny'; reason: string }> {
    const dangerous = PermissionManager.DANGEROUS_PATTERNS.find(
      p => p.tool === toolName && p.check(args)
    );
    if (dangerous) return this.prompt(toolName, args, dangerous.reason, preview);

    if (posture === 'plan' && PLAN_REFUSED_TOOLS.has(toolName)) {
      return {
        decision: 'deny',
        reason:
          `${toolName} is not available in plan mode — you are working out an approach, not applying it. ` +
          `Read, search and analyse freely, then present the plan and let the user switch mode to run it. ` +
          `Do NOT reproduce by hand what this tool would have told you.`,
      };
    }

    if (posture === 'auto') return 'allow';
    if (posture === 'accept_edits' && EDIT_TOOLS.has(toolName)) return 'allow';

    return this.check(toolName, args, preview);
  }

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

    // THE moment an unattended run dies: stopped, waiting for a human, and
    // indistinguishable from "thinking hard" to anything watching from outside.
    // Announce it (veeWM `report-agent` + the terminal title) for as long as the
    // prompt is up, so a supervisor — or the user's status bar — can see that this
    // session needs a person. `whileBlocked` restores `working` however the prompt
    // ends, including a denial or an abort.
    const answer = await whileBlocked(
      `approve: ${toolName}${reason ? ` (${reason})` : ''}`,
      () => this.promptHandler!(toolName, args, reason, preview),
    );
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
