
# VEEPEE Code

AI coding assistant powered by your own Ollama fleet — a Claude Code-style CLI with 26 tools, zero API costs, full data privacy, and cross-device sync.

![VEEPEE Code TUI](docs/screenshots/tui-main.png)

## What is it?

VEEPEE Code is a full-screen terminal AI assistant that connects to your own [Ollama](https://ollama.com/) instance (or an [Ollama Fleet Manager](https://github.com/vpontual/llm-traffic-manager) proxy). It gives you a Claude Code-style coding experience with:

- **Zero API cost** — every inference runs on your GPUs
- **Full data privacy** — nothing leaves your network
- **26 integrated tools** — coding, web, devops, home automation, social, productivity
- **Smart model routing** — auto-benchmarks your models and picks the best one per task
- **Cross-device sync** — push/pull sessions via WebDAV (Nextcloud, etc.)
- **Remote Connect** — phone-accessible web UI for mobile coding
- **Sandbox & Preview** — scratch space for experiments + inline script execution

## Install

### Prerequisites

- **Node.js 20+**
- **GitHub CLI (`gh`)** — [cli.github.com](https://cli.github.com)
- **Ollama** running on at least one machine

### One-liner

```bash
gh repo clone vpontual/veepee-code ~/.veepee-code && bash ~/.veepee-code/install.sh
```

The installer checks prerequisites, handles GitHub authentication, clones the repo, builds from source, and creates both `vcode` and `veepee-code` commands.

### Manual

```bash
gh repo clone vpontual/veepee-code
cd veepee-code
npm install && npm run build
npm link   # creates global vcode and veepee-code commands
```

## First launch

```bash
vcode
```

On first run, a **guided setup wizard** walks you through every configuration step:

1. **GitHub authentication** — `gh auth login` + credential setup
2. **Ollama proxy URL** (required) — connects and verifies your models
3. **Fleet Manager dashboard** — for multi-GPU load balancing
4. **Model preferences** — auto-switch, size limits
5. **API server port** — for external tool integration
6. **Integrations** — SearXNG, Home Assistant, Mastodon, Spotify, Google Workspace, Newsfeed

Each step explains what it does, which tools it enables, and whether it's required or optional. Skip any optional step by pressing Enter.

After setup, VEEPEE Code runs a **smart benchmark** on all your models and builds a **model roster** — the best model for each role:

| Role | Purpose |
|------|---------|
| `act` | Default coding and execution |
| `plan` | Architecture and reasoning |
| `chat` | Fast conversational Q&A |
| `code` | Code generation and editing |
| `search` | Sub-agent tasks |

## Usage

### Ask questions

```
> What does the auth middleware do?
```

### Edit code

```
> Fix the off-by-one error in src/utils/paginate.ts
```

### Run commands

```
> Run the tests and fix any failures
```

### Switch modes

```
/plan     # Thinking-first mode with best reasoning model
/act      # Execution mode with all tools (default)
/chat     # Fast conversational mode with web access
/moe      # Mixture of Experts — 3 models discuss
```

### Session management

```
/save my-refactor     # Save conversation
/sessions             # List saved sessions
/resume my-refactor   # Resume a session
```

### Sandbox & Preview

```
/sandbox              # List sandbox files
/sandbox keep file.py # Move to working directory
/run sandbox:test.py  # Run a sandbox script
/preview index.html   # Serve HTML in browser
/preview stop         # Stop preview server
```

### Sync & Remote Connect

```
/sync push            # Push current session to WebDAV
/sync pull            # Pull sessions from WebDAV
/rc                   # Show Remote Connect URL
```

### Project instructions

```
/init                    # Generate VEEPEE.md with project-specific context
/setup                   # Check integration status
/setup wizard            # Re-run the full setup wizard
/setup wizard spotify    # Reconfigure just one integration
```

## Tools (26)

| Category | Tools |
|----------|-------|
| **Coding** | `read_file`, `write_file`, `edit_file`, `list_files`, `glob`, `grep`, `bash`, `git` |
| **DevOps** | `docker`, `system_info` |
| **Web** | `web_search`, `web_fetch`, `http_request` |
| **Home** | `home_assistant`, `timer`, `weather` |
| **Social** | `mastodon`, `spotify` |
| **Google** | `email`, `calendar`, `google_drive`, `google_docs`, `google_sheets`, `notes` |
| **News** | `news` |
| **System** | `update_memory` |

## CLI flags

```bash
vcode                              # Interactive TUI
vcode -p "explain this codebase"   # Print mode (non-interactive)
vcode -c                           # Continue last session
vcode --resume my-session          # Resume a named session
vcode --host 0.0.0.0 --port 9000  # Custom API server bind
vcode --wizard                     # Re-run setup wizard
vcode --update                     # Pull latest and rebuild
```

## API server

VEEPEE Code exposes an OpenAI-compatible API on port 8484 (configurable). Other tools can use your local models through it:

```bash
# Claude Code
CLAUDE_CODE_USE_BEDROCK=0 claude --model openai/MODEL --api-base http://localhost:8484/v1

# OpenCode
# Set provider URL to http://localhost:8484/v1
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit |
| `Shift+Enter` | New line |
| `Ctrl+P` or `/` | Command palette |
| `Tab` | Show tools |
| `Ctrl+C` | Interrupt / clear |
| `Ctrl+D` | Quit |
| `Ctrl+L` | Clear screen |
| `Up/Down` | Input history |
| `Scroll` | Browse conversation |

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────┐
│  VEEPEE Code │────>│  Ollama Proxy    │────>│  GPU Server  │
│              │     │  (fleet manager) │     │  (DGX/AGX)   │
│  TUI + Agent │     │                  │────>│  GPU Server  │
│  26 tools    │     │  Load balancing  │     │  (Nano/etc)  │
│  API :8484   │     │  Dashboard :3334 │     └──────────────┘
└──────────────┘     └──────────────────┘
```

VEEPEE Code runs locally. Inference requests go through the proxy to your GPU servers. Tool execution (file I/O, shell, APIs) happens on the machine running VEEPEE Code.

## Supported models

Any Ollama model with tool-calling support works. Tested and benchmarked:

| Model | Size | Best for |
|-------|------|----------|
| `qwen3.5:35b` | 35B | Act, code, plan |
| `qwen3:32b` | 32B | Act, plan |
| `qwen3:8b` | 8B | Chat, search, sub-agents |
| `llama3.3:70b` | 70B | Plan, reasoning |
| `deepseek-r1:32b` | 32B | Plan, reasoning |
| `mistral-small:24b` | 24B | Act, code |
| `gemma3:27b` | 27B | Act, code |
| `command-r:35b` | 35B | Chat |
| `llama3.2-vision` | 11B | Image analysis |

The built-in benchmark automatically ranks your available models and picks the best for each role. No manual configuration needed.

## Docs

Full documentation is in the [`docs/`](docs/) directory:

- [Quickstart](docs/quickstart.md)
- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Tools Reference](docs/tools.md)
- [Models & Benchmarking](docs/models.md)
- [Modes](docs/modes.md)
- [Permissions](docs/permissions.md)
- [TUI](docs/tui.md)
- [CLI Reference](docs/cli-reference.md)
- [API](docs/api.md)
- [Sandbox & Preview](docs/sandbox-preview.md)
- [Sync & Remote Connect](docs/sync-rc.md)

## License

Private repository. All rights reserved.
