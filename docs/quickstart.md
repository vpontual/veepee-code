---
title: "Quickstart"
description: "Install VEEPEE Code and start coding with your local AI in under 5 minutes."
weight: 2
---

# Quickstart

## Prerequisites

Before installing VEEPEE Code, make sure you have:

1. **Ollama** running on at least one machine -- either locally (`localhost:11434`) or on a remote GPU server.
2. **git** -- For cloning the repository.
3. **Node.js 20+** -- The installer handles this automatically via nvm if not present.
4. **Ollama Fleet Manager** (optional) -- A proxy that routes requests across your GPU fleet. VEEPEE Code works without it by connecting directly to Ollama.

## Installation

### One-liner (recommended)

```bash
curl -fsSL https://vitorpontual.com/install.sh | bash
```

The installer handles everything automatically: installs nvm and Node.js 22 if needed, clones the repo, builds, and links the `vcode` command.

### Manual

```bash
git clone https://github.com/vpontual/veepee-code.git ~/.veepee-code
cd ~/.veepee-code
npm install && npm run build
npm link
```

### npm (when published)

```bash
npm install -g veepee-code
```

### Git clone (manual)

```bash
gh repo clone vpontual/veepee-code
cd veepee-code
npm install
npm run build
npm link   # Creates global `vcode` and `veepee-code` commands
```

Then run with:

```bash
vcode                # Global command (after npm link)
veepee-code          # Alternative global command name
node dist/index.js   # Direct execution
npx tsx src/index.ts # During development

# CLI flags
vcode -p "explain this codebase"   # Print mode: one-shot, non-interactive
vcode -c                           # Continue: resume the last session
vcode --resume my-session          # Resume a named session
vcode --host 0.0.0.0 --port 9000  # Bind API server to custom host/port
vcode --wizard                    # Re-run the guided setup wizard
```

## First Run

After installation, navigate to any project directory and start VEEPEE Code:

```bash
cd ~/my-project
vcode
```

On first launch, VEEPEE Code will:

1. **Run the setup wizard** -- A guided onboarding walks you through all configuration step-by-step: GitHub authentication, Ollama proxy connection, model preferences, and optional integrations (Home Assistant, Mastodon, Spotify, Google Workspace, SearXNG, Newsfeed). Each step explains what it does, which tools it enables, and whether it's required or optional. Optional steps can be skipped by pressing Enter.
2. **Connect to the proxy** -- It contacts the Ollama proxy URL from your config.
3. **Discover models** -- It queries the proxy for available models and (if configured) the Fleet Manager dashboard for loaded model status and capabilities.
5. **Select an initial model** -- The highest-scoring model with tool-calling support becomes the temporary default.
6. **Register tools** -- All 26 tools are initialized based on your `.env` configuration. Tools with missing credentials are silently skipped.
7. **Start the API server** -- An OpenAI-compatible API server starts on port 8484 (configurable).
8. **Launch the TUI** -- The full-screen terminal interface appears with the VEEPEE CODE logo and input box.
9. **Run the first-launch benchmark** -- Automatically inside the TUI with live progress:
   - **Phase 1:** Quick responsiveness check on all models with tool support. Sends a prompt, allows up to 60 seconds for cold-start model loading, then measures generation speed (tok/s). Models with <1 tok/s are filtered out.
   - **Phase 2:** Full benchmark on surviving models (tool calling, code generation, code editing, instruction following, reasoning, context probing). Note: context probing is optional and skipped on first launch to speed up initial setup.
   - **Phase 3:** Builds a **model roster** -- assigns the best model per role (act, plan, chat, code, search) based on benchmark scores and speed. The act model becomes the new default.
   - Results are saved to `~/.veepee-code/benchmarks/` and the roster to `roster.json`. Subsequent launches skip the benchmark and load the saved roster.

## Configuring the Proxy URL

The setup wizard configures this automatically on first launch. To change it later, either re-run the wizard (`vcode --wizard` or `/setup wizard`) or edit the config directly:

```bash
# Edit the global config
nano ~/.veepee-code/.env
```

Set the proxy URL:

```bash
VEEPEE_CODE_PROXY_URL=http://your-server:11434
VEEPEE_CODE_DASHBOARD_URL=http://your-server:3334   # Only if using Ollama Fleet Manager
```

Or create a project-local `.env` file in your working directory, which takes precedence over the global config.

## Basic Usage

### Ask a question

Just type your question or instruction and press Enter. Use **Shift+Enter** for multi-line input. Reference files inline with **@file** mentions (e.g., `@src/index.ts`):

```
> What does the auth middleware do in this project?
```

VEEPEE Code will read relevant files, search for patterns, and give you a concise answer.

### Edit code

```
> Fix the off-by-one error in src/utils/paginate.ts
```

The agent will read the file, identify the bug, and use the `edit_file` tool to make a precise string replacement.

### Run commands

```
> Run the test suite and fix any failures
```

The agent will execute `bash` to run tests, read error output, edit failing test files or source files, and re-run until tests pass.

### Web search

```
> What's the latest version of Next.js and what changed?
```

The agent uses `web_search` (via SearXNG) to find current information, then summarizes it.

### Switch modes

```
/plan            # Think through a problem before coding
/chat            # Conversational mode with web access, no file editing
/act             # Back to default execution mode
```

### Save and resume sessions

```
/save my-refactor    # Save current conversation
/sessions            # List saved sessions
/resume my-refactor  # Resume a saved session
/effort              # Set model effort level (low/medium/high)
/worktree            # Manage git worktrees
/rename              # Rename the current session
/add-dir             # Add a directory to the working context

# Sandbox & Preview
/sandbox             # List sandbox files
/sandbox keep file   # Move file to cwd
/preview index.html  # Serve HTML in browser
/run test.py         # Execute a script

# Sync & Remote
/sync push           # Push session to WebDAV
/sync pull           # Pull sessions from WebDAV
/rc                  # Show Remote Connect URL
```

Or resume from the command line:

```bash
vcode --resume my-refactor
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit input |
| `Shift+Enter` | New line (multi-line input) |
| `Tab` | Show available tools |
| `Ctrl+P` | Open command palette |
| `/` | Open command palette (when typed as first character) |
| `Ctrl+L` | Clear screen |
| `Ctrl+D` | Quit |
| `Ctrl+C` | Interrupt generation / clear input |
| `Up/Down` | Browse input history |
| `Left/Right` | Move cursor |
| `Home/End` | Jump to start/end of input |
| `Scroll Up/Down` | Scroll through conversation output |

## Verifying Your Setup

Run the setup validation command to check which integrations are active:

```
/setup            # Check integration status
/setup wizard     # Re-run the guided setup wizard
```

`/setup` tests connectivity to your proxy, SearXNG, Home Assistant, Mastodon, Spotify, Google Workspace, and news feed. Each integration shows its status (active, missing config, or error) and which tools it provides. Use `/setup wizard` to reconfigure any integration interactively.

## Creating Project Instructions

Generate a VEEPEE.md file for your project:

```
/init
```

The agent analyzes your project structure, reads config files and source code, and creates a VEEPEE.md with build commands, code style guidelines, architecture notes, and common gotchas. This file is automatically loaded into every future session and added to `.gitignore`.

## Next Steps

- [Configuration Reference](configuration.md) -- All environment variables and config files
- [Modes](modes.md) -- Understanding act, plan, and chat modes
- [Tools Reference](tools.md) -- All 26 tools with usage examples
- [Models](models.md) -- Model discovery, ranking, and the model roster
- [Benchmarking](benchmark.md) -- Smart benchmark, roster building, and interpreting results
- [Sandbox & Preview](sandbox-preview.md) -- Scratch space, script execution, HTML preview
- [Sync & Remote Connect](sync-rc.md) -- Cross-device sync and phone web UI
