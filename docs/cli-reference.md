---
title: "CLI Reference"
description: "Complete reference for all slash commands, CLI flags, and keyboard shortcuts."
weight: 14
---

# CLI Reference

All interaction with VEEPEE Code happens through the input box in the TUI. Type natural language prompts to interact with the agent, or use slash commands to control the session.

## CLI Flags

```bash
vcode                          # Start in current directory
vcode --resume <name-or-id>    # Resume a saved session
veepee-code                    # Alternative command name
```

| Flag | Description |
|------|-------------|
| `--resume <query>` | Resume a saved session by name or ID. Supports exact match, starts-with, and contains matching. |
| `-p`, `--print <query>` | Non-interactive mode. Runs the query and outputs the result to stdout, then exits. Useful for scripting and pipelines. |
| `-c`, `--continue` | Resume the most recent session automatically. |
| `--host=<addr>` | API bind address (default `127.0.0.1`). |
| `--port=<port>` | API port (default `8484`). |
| `--json-schema=<file>` | Structured JSON output mode. Requires `-p`. The agent's response is constrained to match the JSON schema defined in the given file. |

## Commands

### Session Management

#### /save [name]

Save the current conversation as a session.

```
/save                 # Auto-names from first user message
/save my-refactor     # Save with a custom name
```

Sessions are stored as JSON at `~/.veepee-code/sessions/`. If the session was previously saved (has an ID), `/save` updates the existing session file.

#### /sessions

List all saved sessions, newest first.

```
/sessions
```

Output shows session name, age, message count, tool call count, model, and working directory.

#### /resume <name>

Resume a saved session by name (fuzzy match).

```
/resume my-refactor    # Resume by name
/resume auth           # Fuzzy match -- finds "auth-fix", "auth module refactor", etc.
```

Without arguments, shows the session list with a hint to use `/resume <name>`.

Resuming a session:
- Clears the current conversation
- Restores all messages (user, assistant, tool results)
- Restores the model if it is still available
- Shows a confirmation with message count

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

Before trimming, `/compact` now asks the model to verify its knowledge state -- confirming what it knows about the current task, files, and decisions -- so that critical context survives compaction.

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

Enter plan mode. The agent switches to the roster's plan model (best reasoning), enables thinking, and adopts a clarify-first behavior.

```
/plan
```

See [Modes](modes.md) for details.

#### /act

Return to act (execution) mode. Restores the roster's act model, re-enables auto-switching, and disables thinking.

```
/act
```

#### /chat

Enter chat mode. Switches to the roster's chat model (fastest conversational) with only web tools available.

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

The agent analyzes the project structure, reads config files and source code, and creates a VEEPEE.md. If one already exists, it is read and improved. Automatically adds VEEPEE.md to .gitignore. See [VEEPEE.md](veepee-md.md) for details.

### Response Control

#### /effort low|medium|high

Set the response depth for the current session.

```
/effort low       # 256 max tokens, 0.3 temperature -- terse answers
/effort medium    # 1024 max tokens, 0.5 temperature -- balanced (default)
/effort high      # 4096 max tokens, 0.7 temperature -- detailed, creative
```

Affects all subsequent responses until changed again or the session ends.

### Workspace Management

#### /worktree [list|create [name]|cleanup]

Manage git worktree isolation for experiments.

```
/worktree              # Show current worktree status
/worktree list         # List all worktrees
/worktree create exp   # Create a new worktree named "exp" and switch into it
/worktree cleanup      # Remove merged/stale worktrees
```

Worktrees let you experiment in an isolated branch without affecting your main working directory. Requires a git repository.

#### /rename <name>

Rename the current session mid-conversation.

```
/rename auth-refactor
```

Updates the session name without saving. Use `/save` afterward to persist the new name.

#### /add-dir <path>

Add an additional working directory to the current session.

```
/add-dir /Users/vp/Documents/Development/shared-lib
```

The agent can then read and edit files in the added directory. Useful for working across multiple projects.

### Extended Benchmarking

#### /benchmark context

Probe optimal context sizes per model. Sends progressively larger prompts to each model and measures throughput and quality, identifying the sweet spot before performance degrades. This is separate from the main `/benchmark` suite.

```
/benchmark context
```

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
| `Shift+Enter` | Insert newline (multi-line input) |
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
| `Ctrl+P` | Open command palette (types `/` and shows command menu) |
| `/` | Open command palette (when typed as first character) |
| `Ctrl+L` | Clear screen and messages, return to welcome |
| `Ctrl+C` | Interrupt running agent / clear current input text |
| `Ctrl+D` | Quit VEEPEE Code |

### Scrolling

| Key | Action |
|-----|--------|
| `Scroll` / `Mouse wheel` | Scroll conversation |
| `PgUp` / `PgDn` | Scroll conversation by page |
| `Shift+Up` / `Shift+Down` | Scroll conversation by line |

### Command Palette Navigation

When the command palette is open (after typing `/` or pressing `Ctrl+P`):

| Key | Action |
|-----|--------|
| `Up/Down` | Navigate menu items |
| `Enter` | Select command (submits immediately if no args needed) |
| `Tab` | Accept selection and continue typing (for commands that take args) |
| `Esc` | Close command palette |
| Typing | Filters the command list |

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
| `/save [name]` | Save session |
| `/sessions` | List saved sessions |
| `/resume <name>` | Resume a session |
| `/permissions` | View permissions |
| `/revoke <tool>` | Revoke always-allow |
| `/effort low\|medium\|high` | Set response depth |
| `/worktree [action]` | Git worktree isolation |
| `/rename <name>` | Rename current session |
| `/add-dir <path>` | Add working directory |
| `/benchmark [tier]` | Run benchmarks |
| `/benchmark context` | Probe optimal context sizes |
| `/benchmark results` | Show results |
| `/benchmark summary` | Show summary |
| `/quit` / `/exit` / `/q` | Exit |
