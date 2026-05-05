/**
 * Extras — opinionated language/stack bundles, inspired by LazyVim's
 * `:LazyExtras`. One extra packages: LSP recipes, post-edit hooks (e.g.
 * formatters), and a system-prompt section that injects when the extra
 * is active AND the cwd looks like a matching project.
 *
 * The extra system is intentionally small: a few well-curated bundles
 * users can opt into with `/extras add <name>`. New extras are added as
 * entries in BUILTIN_EXTRAS — no plugin loader, no remote registry.
 */

export interface ExtraHookCommand {
  /** Optional matcher (tool name regex). When omitted, runs for every event. */
  matcher?: string;
  /** Shell command. Should detect missing tools gracefully (e.g. `command -v
   *  prettier && prettier --write "$VEEPEE_TOOL_PATH"`). */
  command: string;
  description?: string;
}

export interface Extra {
  /** Stable name used as the key in `config.extras` and on the CLI. */
  name: string;
  /** Human-readable description rendered in /extras list. */
  description: string;
  /** Files that signal this extra applies to the cwd. Detected at session
   *  start; presence in cwd is used to decide whether to inject the
   *  system-prompt section. */
  projectMarkers: string[];
  /** LSP recipe labels to install when `/extras add <name>` runs. */
  lspRecipes: string[];
  /** PostToolUse hook commands to register when the extra is added.
   *  Typically formatters or linters. Run automatically after edits. */
  postEditHooks: ExtraHookCommand[];
  /** Markdown injected into the system prompt when the extra is active and
   *  the project matches. Keep concise — every extra adds tokens. */
  systemPromptSection: string;
  /** Built-in extras don't carry runtime enabled state — that lives in
   *  config.extras as the canonical "is this active?" signal. The optional
   *  flag here lets a future user-supplied extra carry its own toggle. */
  enabled?: boolean;
}
