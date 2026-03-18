---
title: "CLI Reference"
description: "Complete reference for all slash commands and keyboard shortcuts."
weight: 14
---

# CLI Reference

All interaction with VEEPEE Code happens through the input box in the TUI. Type natural language prompts to interact with the agent, or use slash commands to control the session.

## Commands

### Session Management

#### /clear

Clear the conversation history and reset session permissions.

```
/clear
```

Clears all messages, resets tool permission grants for the session (persistent always-allow permissions are kept), and returns to the welcome screen.

#### /compact

Compact the conversation to free context space.

```
/compact
```

If the estimated token count exceeds 80% of the 32K context budget and there are more than 12 messages, compaction drops older messages while keeping the first message and the 10 most recent. A summary message replaces the dropped content.

If compaction is not needed (context is below threshold), reports "No compaction needed."

> **Note:** Compaction also happens automatically during the agent loop when context pressure is detected.

#### /status

Show current session information.

```
/status
```

Output:

```
Session:
  Model:    qwen3.5:35b
  Messages: 24
  Tokens:   ~8,500
  Tools:    25
  API:      http://localhost:8484
  CWD:      /Users/vp/my-project
```

#### /quit, /exit, /q

Exit VEEPEE Code. Stops the API server, restores the terminal, and exits the process.

```
/quit
```

Equivalent to pressing `Ctrl+D`.

### Mode Switching

#### /plan

Enter plan mode. The agent switches to the heaviest available model with thinking support, enables thinking, and adopts a clarify-first behavior.

```
/plan
```

See [Modes](modes.md) for details.

#### /act

Return to act (execution) mode. Restores the previous model, re-enables auto-switching, and disables thinking.

```
/act
```

#### /chat

Enter chat mode. Switches to a fast standard-tier model with only web tools available.

```
/chat
```

### Model Management

#### /model

Show or switch the current model.

```
/model                    # Show current model
/model qwen3.5:35b        # Switch to a specific model
/model qwen3              # Partial name match
/model auto               # Re-enable auto-switching
```

When you manually select a model, auto-switching is disabled. Use `/model auto` to re-enable it.

#### /models

List all discovered models organized by tier, with scores, capabilities, and loaded status.

```
/models
```

### Tool Management

#### /tools

List all registered tools with descriptions.

```
/tools
```

Output shows tool count and each tool with a truncated description:

```
25 tools:
  bash                 Execute a shell command and return its output...
  calendar             Manage Google Calendar: list upcoming events...
  docker               Run Docker commands: ps, logs, exec, build...
  ...
```

### Permission Management

#### /permissions (or /perms)

View current permission status across all three categories.

```
/permissions
```

Output:

```
Permissions:
  Safe (auto-allowed): git, glob, grep, list_files, news, read_file, system_info, weather
  Always allowed: bash, edit_file, write_file
  Session allowed: docker
```

#### /revoke

Remove a tool from the persistent always-allowed list.

```
/revoke <tool_name>
```

Examples:

```
/revoke bash         # Revoke always-allow for bash
/revoke mastodon     # Revoke always-allow for mastodon
```

After revoking, the tool will prompt for permission on its next use.

### Benchmarking

#### /benchmark

Run the benchmark suite against models.

```
/benchmark              # Benchmark all models
/benchmark heavy        # Only heavy-tier (25B+)
/benchmark standard     # Only standard-tier (6-25B)
/benchmark light        # Only light-tier (<6B)
/benchmark results      # Show latest results table
/benchmark show         # Alias for results
/benchmark summary      # Show compact summary with category winners
```

See [Benchmarking](benchmark.md) for details.

### Setup and Initialization

#### /setup

Validate all integrations and show their status.

```
/setup
```

Tests connectivity to the proxy, SearXNG, Home Assistant, Mastodon, Spotify, Google Workspace, and newsfeed. See [Setup Validation](setup-validation.md) for details.

#### /init

Generate or improve a VEEPEE.md project instructions file.

```
/init
```

The agent analyzes the project structure, reads config files and source code, and creates a VEEPEE.md. If one already exists, it is read and improved. Automatically adds VEEPEE.md to .gitignore. See [VEEPEE.md](llama-md.md) for details.

### Help

#### /help

Show the built-in help with all commands, modes, benchmark options, and keyboard shortcuts.

```
/help
```

## Keyboard Shortcuts

### Input Editing

| Key | Action |
|-----|--------|
| `Enter` | Submit input |
| `Backspace` | Delete character before cursor |
| `Left Arrow` | Move cursor left |
| `Right Arrow` | Move cursor right |
| `Home` / `Ctrl+A` | Move cursor to beginning of input |
| `End` / `Ctrl+E` | Move cursor to end of input |

### History Navigation

| Key | Action |
|-----|--------|
| `Up Arrow` | Previous command from history |
| `Down Arrow` | Next command in history (or clear input) |

The history buffer holds up to 100 entries for the session.

### Quick Actions

| Key | Action |
|-----|--------|
| `Tab` | Show all tools (submits `/tools`) |
| `Ctrl+P` | Show help (submits `/help`) |
| `Ctrl+L` | Clear screen and messages, return to welcome |
| `Ctrl+C` | Clear current input text |
| `Ctrl+D` | Quit VEEPEE Code |

### Permission Prompt Keys

When a permission prompt is active:

| Key | Action |
|-----|--------|
| `y` / `Y` | Allow (session) |
| `a` / `A` | Always allow (persistent) |
| `n` / `N` / `Esc` | Deny |

## Command Summary Table

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/model <name>` | Switch model |
| `/model auto` | Enable auto-switching |
| `/models` | List all models |
| `/tools` | List all tools |
| `/clear` | Clear conversation |
| `/compact` | Free context space |
| `/status` | Session info |
| `/plan` | Enter plan mode |
| `/act` | Enter act mode |
| `/chat` | Enter chat mode |
| `/init` | Create/improve VEEPEE.md |
| `/setup` | Validate integrations |
| `/permissions` | View permissions |
| `/revoke <tool>` | Revoke always-allow |
| `/benchmark [tier]` | Run benchmarks |
| `/benchmark results` | Show results |
| `/benchmark summary` | Show summary |
| `/quit` / `/exit` / `/q` | Exit |
