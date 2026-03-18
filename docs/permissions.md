---
title: "Permissions"
description: "Permission system: safe tools, dangerous patterns, session vs persistent permissions, and management commands."
weight: 8
---

# Permissions

VEEPEE Code includes a permission system that balances productivity (letting the agent work autonomously) with safety (preventing unintended side effects). The system classifies tool calls into three categories and prompts the user only when necessary.

## How It Works

When the agent makes a tool call, the permission manager evaluates it through three checks in order:

1. **Dangerous pattern check** -- Certain tool + argument combinations are always flagged, regardless of other permissions. These are hard-coded patterns that could cause irreversible damage.

2. **Safe tool check** -- Read-only tools are auto-allowed without prompting.

3. **Permission store check** -- If the tool has been previously allowed (for this session or permanently), it runs without prompting.

4. **User prompt** -- If none of the above apply, the user is asked to approve or deny the action.

## Safe Tools (Auto-Allowed)

These tools are considered safe and never prompt for permission:

| Tool | Reason |
|------|--------|
| `read_file` | Read-only file access |
| `list_files` | Read-only directory listing |
| `glob` | Read-only file search |
| `grep` | Read-only content search |
| `git` | Most git commands are read-only (status, log, diff) |
| `weather` | Public weather API, no side effects |
| `system_info` | Read-only system information |
| `news` | Read-only news access |

> **Note:** While `git` is in the safe list for read operations, dangerous git patterns (force push, hard reset) are caught by the dangerous pattern check and will still prompt.

## Dangerous Patterns (Always Prompt)

These patterns always require explicit approval, even if the tool has been permanently allowed:

| Tool | Pattern | Reason |
|------|---------|--------|
| `bash` | `rm -rf` or `rm -r` | Destructive file deletion |
| `bash` | `git push --force` | Force push to remote |
| `bash` | `git reset --hard` | Hard reset discards changes |
| `bash` | `docker rm`, `docker rmi`, `docker system prune` | Container/image cleanup |
| `git` | `push --force` | Force push |
| `git` | `reset --hard` | Hard reset |
| `home_assistant` | `turn_on`, `turn_off`, `toggle`, `call_service` | Device control |
| `mastodon` | `post`, `reply`, `boost` | Public social media actions |
| `email` | `send` | Sending email |
| `spotify` | `play`, `pause`, `next`, `previous`, `volume` | Playback control |

## The Permission Prompt

When a tool call requires approval, the TUI displays:

```
  ⚠ Permission required: bash (destructive delete)
    command: rm -rf /tmp/old-build
  [y] Yes  [a] Always allow bash  [n] No
```

### Response Options

| Key | Action | Scope |
|-----|--------|-------|
| `y` / `Y` | Allow this once | Session only. The tool is added to the session-allowed list. Future calls to this tool (that don't match dangerous patterns) are auto-allowed for the rest of the session. |
| `a` / `A` | Always allow | Persistent. The tool is added to the always-allowed list, saved to `~/.veepee-code/permissions.json`. Applies to all future sessions. |
| `n` / `N` / `Esc` | Deny | The tool call is skipped. The agent receives a "Permission denied" message and continues with the next step. |

## Permission Scopes

### Session Permissions

- Granted by pressing `y` at the prompt
- Cleared when the conversation is cleared (`/clear`) or when VEEPEE Code exits
- Apply to the tool name (e.g., allowing `bash` once means all non-dangerous `bash` calls are auto-allowed for the session)

### Persistent Permissions

- Granted by pressing `a` at the prompt
- Saved to `~/.veepee-code/permissions.json`
- Survive across sessions and restarts
- Can be revoked with `/revoke`

### Safe Tool Permissions

- Hard-coded in the source
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
  Safe (auto-allowed): git, glob, grep, list_files, news, read_file, system_info, weather
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
  ]
}
```

This file is created automatically when you first press `a` at a permission prompt. The directory is created if it does not exist.

## Design Philosophy

The permission system follows the principle of least surprise:

- **Reading is always safe.** The agent should never need to ask before reading a file, searching code, or checking system status.
- **Writing needs consent.** The first time the agent tries to edit a file or run a build, you decide whether to trust it.
- **Destruction needs confirmation every time.** Even if you have always-allowed `bash`, `rm -rf` still prompts. Some actions are too consequential to auto-approve.
- **External actions need consent.** Posting to social media, sending email, and controlling smart home devices always prompt because they have real-world consequences beyond your filesystem.
