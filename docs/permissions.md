---
title: "Permissions"
description: "Permission system: safe tools, dangerous patterns, session vs persistent permissions, and management commands."
weight: 8
---

# Permissions

VEEPEE Code includes a permission system that balances productivity (letting the agent work autonomously) with safety (preventing unintended side effects). The system classifies tool calls into three categories and prompts the user only when necessary.

## How It Works

When the agent makes a tool call, the permission manager evaluates it through these checks in order:

1. **Dangerous pattern check** -- Certain tool + argument combinations are always flagged, regardless of other permissions. These are hard-coded patterns that could cause irreversible damage.

2. **Safe tool check** -- Read-only tools are auto-allowed without prompting.

3. **Persistent / session / project store check** -- If the tool has been previously allowed (always, for this session, or for files in this project directory), it runs without prompting.

4. **User prompt** -- If none of the above apply, the user is asked to approve or deny the action.

## Safe Tools (Auto-Allowed)

These tools are considered safe and never prompt for permission (hardcoded in `permissions.ts`):

| Tool | Reason |
|------|--------|
| `read_file` | Read-only file access |
| `list_files` | Read-only directory listing |
| `glob` | Read-only file search |
| `grep` | Read-only content search |
| `weather` | Public weather API (when surfaced via the remote bridge) |
| `system_info` | Read-only system information |
| `news` | Read-only news access (when surfaced via the remote bridge) |
| `update_memory` | Writes to the knowledge state file, no external side effects |

### `git` is allowed per-subcommand, not wholesale

`git` used to sit in the safe list. It doesn't any more: it takes arbitrary subcommands, so blanket-allowing it meant `git push -f` and `git clean -fdx` ran with **no prompt at all**.

Instead, git is auto-allowed only when the **first** token is a subcommand with no write form:

```
status  log  diff  show  blame  shortlog  whatchanged  rev-parse  rev-list
describe  ls-files  ls-remote  ls-tree  merge-base  name-rev  cat-file
count-objects  grep  annotate  verify-commit  check-ignore  diff-tree
symbolic-ref
```

Everything else — `commit`, `add`, `push`, `checkout`, `branch`, `stash`, `config`, `remote` — goes through the normal prompt. Subcommands that are *usually* read-only but have destructive modes (`branch -D`, `tag -d`, `stash drop`, `reflog expire`, `config` writes) are deliberately excluded rather than special-cased.

The subcommand must come first, and these flags disqualify the invocation anywhere in the arguments:

`-c` · `-O` · `--config-env` · `--output` · `--upload-pack` · `--receive-pack` · `--exec` · `--ext-diff`

They turn a read-only subcommand into code execution or a file write — `git -c core.pager='sh -c ...' log` runs an arbitrary command, and `git diff --output=FILE` writes to disk.

## Ignore Files

Paths can be blocked from the agent entirely with an ignore file. Two names are read, at both the global (`~/.veepee-code/`) and project level:

| Filename | Convention |
|---|---|
| `.agentignore` | The cross-agent standard, shared with other tools |
| `.veepeignore` | VEEPEE Code's own |

Unlike instruction files these are **additive** — a repo with both blocks everything either one names. `.veepeignore` is read last, so its negations (`!pattern`) can un-block something the shared file denies.

Patterns follow gitignore conventions: a trailing slash (`secrets/`) blocks the directory and everything under it, and a bare name (`node_modules`) blocks the entry and its contents. Symlinks are resolved before matching, so a link pointing at a blocked file is blocked too.

## Dangerous Patterns (Always Prompt)

These patterns always require explicit approval, even if the tool has been permanently allowed. The list is hardcoded in `permissions.ts → DANGEROUS_PATTERNS`:

Matching is flag-aware rather than literal, because the destructive forms have many equivalent spellings: `rm -rf`, `rm -fr`, `rm -r -f` and `rm --recursive --force` are all the same command, and `git push -f` is the same as `git push --force`. Bundled short flags (`-fdx`) are decomposed, and each shell-separated segment is inspected, so `make dist && rm -fr build` is caught.

| Tool | Pattern | Reason |
|------|---------|--------|
| `bash` | recursive `rm` (any flag spelling) | Destructive file deletion |
| `bash` | `git push` with `-f` / `--force` / `--force-with-lease` | Force push to remote |
| `bash` | `git reset --hard` | Hard reset discards changes |
| `bash` | `git clean` with `-f` / `--force` | Deletes untracked files (including `.env`) |
| `bash` | `docker rm`, `docker rmi`, `docker system prune` | Container/image cleanup |
| `bash` | `mkfs*`, `shred` | Destroys data irrecoverably |
| `bash` | `dd ... of=` | Raw disk write |
| `git` | `push` with `-f` / `--force` / `--force-with-lease` | Force push |
| `git` | `reset --hard` | Hard reset |
| `git` | `clean` with `-f` / `--force` | Deletes untracked files |
| `git` | `checkout .` / `restore .` | Discards all local changes |
| `git` | `branch -D` / `-d`, `tag -d` | Deletes a branch or tag |
| `git` | `stash drop` / `stash clear` | Discards stashed work |
| `git` | `filter-branch`, `filter-repo` | Rewrites history |
| `git` | `reflog delete` / `expire` | Destroys the recovery log |

Tools that come from the remote agent bridge (Home Assistant device control, Mastodon posting, email sending, Spotify playback control, etc.) handle their own dangerous-action prompts at the remote agent layer — VEEPEE Code itself does not currently parse arguments for those bridged tools.

## The Permission Prompt

When a tool call requires approval, the TUI displays:

```
  ⚠ Permission required: write_file (edit_file)
    path: src/api.ts
  [y] Yes  [s] Session  [a] Always  [p] Project  [n] No
```

### Response Options

| Key | Action | Scope |
|-----|--------|-------|
| `y` / `Y` | Allow this once | Adds the tool to the session-allowed list. Future calls to this tool (that don't match dangerous patterns) are auto-allowed for the rest of the session. |
| `s` | Session (alias of `y`) | Same as `y`. |
| `a` / `A` | Always allow | Persistent. The tool is added to the always-allowed list, saved to `~/.veepee-code/permissions.json`. Applies to all future sessions. |
| `p` / `P` | Project-scoped allow | **Persistent but scoped to the current directory.** Adds a `tool:cwd` entry to `permissions.json → projectAllowed`. On future calls, if the tool has a `path` arg, it is auto-allowed only when the target file is inside that directory. Great for "always allow `write_file` in this repo, but keep prompting elsewhere". |
| `n` / `N` / `Esc` | Deny | The tool call is skipped. The agent receives a "Permission denied" message and continues with the next step. |

## Permission Scopes

### Session Permissions

- Granted by pressing `y` (or `s`) at the prompt
- Cleared when the conversation is cleared (`/clear`) or when VEEPEE Code exits
- Apply to the tool name (e.g., allowing `bash` once means all non-dangerous `bash` calls are auto-allowed for the session)

### Persistent (Always) Permissions

- Granted by pressing `a` at the prompt
- Saved to `~/.veepee-code/permissions.json → alwaysAllowed`
- Survive across sessions and restarts
- Apply to the tool name globally
- Can be revoked with `/revoke`

> **Scope is the whole tool, deliberately.** Pressing `a` on `bash "npm test"`
> allows every later `bash` call, in any directory, until revoked — it is not
> narrowed to `npm` or to the current project. This is a chosen trade-off, not
> an oversight: the friction of per-command grants isn't worth it when the
> genuinely destructive forms are covered by the dangerous-pattern check, which
> runs *before* the always-allow check and therefore still prompts every time.
> If you'd rather trade friction for tighter scope, use `s` (session) instead,
> and `/revoke bash` to drop a grant you regret.

### Project-Scoped Permissions

- Granted by pressing `p` at the prompt
- Saved to `~/.veepee-code/permissions.json → projectAllowed` as `"tool:/absolute/path/to/project"` entries
- Match only when the tool's `path` argument resolves to a file inside the stored directory
- Survive across sessions and restarts
- Useful for letting the agent write freely within one repo without granting a blanket always-allow

### Safe Tool Permissions

- Hard-coded in the source (`PermissionManager.SAFE_TOOLS`)
- Cannot be changed at runtime
- Always auto-allowed

## Management Commands

### /permissions (or /perms)

View all current permissions:

```
/permissions
```

Output:

```
Permissions:
  Safe (auto-allowed): glob, grep, list_files, news, read_file, system_info, weather
  Always allowed: bash, write_file, edit_file
  Session allowed: docker, mastodon
```

### /revoke

Remove a tool from the persistent always-allowed list:

```
/revoke bash
```

Output:

```
Revoked always-allow for bash
```

After revoking, the tool will prompt again the next time it is called (unless it matches the safe list).

### /clear

Clears the conversation and resets session permissions (but not persistent permissions):

```
/clear
```

## Permission Prompt Options (summary)

See the [Response Options](#response-options) table above. The prompt offers five keys: `y` (session), `s` (session alias), `a` (always), `p` (project-scoped), `n` (deny).

## Remote Connect Permission Handling

When Remote Connect (`/rc`) is enabled and web clients are connected, permission requests are routed to the web UI instead of the TUI. The web UI shows a permission card with approve/deny/always buttons. If no web clients are connected, the TUI prompt is used as a fallback.

- Permission requests are emitted as `permission_request` SSE events with a unique `callId`
- The web client responds via `POST /rc/approve` with the `callId` and decision (`y`, `a`, or `n`)
- Unanswered requests auto-deny after 60 seconds
- TUI takes priority if both TUI and web clients are active

## API Mode Behavior

When tool calls are made through the API server (port 8484) rather than the interactive TUI, the permission system auto-allows all calls. This is by design -- the API is intended for programmatic use by other tools (Claude Code, Gemini CLI, custom scripts) that handle their own permission logic.

## Permission Storage Format

Persistent permissions are stored at `~/.veepee-code/permissions.json`:

```json
{
  "alwaysAllowed": [
    "bash",
    "edit_file",
    "write_file"
  ],
  "projectAllowed": [
    "write_file:/home/vp/Dev/my-project",
    "edit_file:/home/vp/Dev/my-project"
  ]
}
```

This file is created automatically when you first press `a` or `p` at a permission prompt. The directory is created if it does not exist.

## Design Philosophy

The permission system follows the principle of least surprise:

- **Reading is always safe.** The agent should never need to ask before reading a file, searching code, or checking system status.
- **Writing needs consent.** The first time the agent tries to edit a file or run a build, you decide whether to trust it.
- **Destruction needs confirmation every time.** Even if you have always-allowed `bash`, `rm -rf` still prompts. Some actions are too consequential to auto-approve.
- **External actions need consent.** Posting to social media, sending email, and controlling smart home devices always prompt because they have real-world consequences beyond your filesystem.
