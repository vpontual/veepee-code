# VEEPEE Code

A Claude Code-style terminal AI assistant that runs entirely on your hardware. Connects to [Ollama](https://ollama.com/) for local inference — zero API costs, full privacy.

![VEEPEE Code TUI](docs/screenshots/tui-main.png)

## Features

- **Local-first** — all inference runs on your GPUs via Ollama
- **15+ coding tools** — file I/O, shell, git, web search, Docker, and more
- **Project-aware** — auto-detects language, framework, package manager, and test runner
- **Smart model routing** — benchmarks your models and picks the best one per task
- **Multiple modes** — Act (coding), Plan (reasoning), Chat (fast Q&A), MoE (multi-model debate)
- **Plan persistence** — implementation plans auto-saved and restored across context compaction
- **Remote agent bridge** — connect a remote agent to unlock additional tools
- **Session management** — save, resume, and sync sessions across devices via WebDAV
- **Remote Connect** — phone-accessible web UI with QR code access
- **Model stick** — lock your preferred model across mode switches
- **Sandbox & Preview** — scratch space for experiments, inline script execution, HTML preview
- **Shell escape** — `!command` for quick terminal access, `/shell` for interactive mode
- **OpenAI-compatible API** — lets other tools (Claude Code, OpenCode) use your local models
- **Multi-GPU support** — works with [Ollama Fleet Manager](https://github.com/vpontual/llm-traffic-manager) for load-balanced inference

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/vpontual/veepee-code/main/install.sh | bash
```

The installer handles everything: nvm, Node.js 22, clone, build, and PATH setup.

### Manual install

```bash
git clone https://github.com/vpontual/veepee-code.git ~/.veepee-code
cd ~/.veepee-code
npm install && npm run build
npm link
```

### Requirements

- **Node.js 20+** (installer handles this automatically)
- **Ollama** running on at least one machine
- **git**, **ripgrep** (optional, improves grep performance)

## Quick start

```bash
vcode
```

A setup wizard runs on first launch — just enter your Ollama URL and you're ready. Everything else is optional.

## Usage

Talk to the AI naturally. It reads and writes files, runs commands, searches the web, and manages git — all with a permission system that keeps you in control.

```
> Fix the off-by-one error in src/utils/paginate.ts
> Run the tests and fix any failures
> What does the auth middleware do?
```

### Modes

| Command | Mode | Description |
|---------|------|-------------|
| `/act` | Act | Default coding mode — all tools, auto-switches models |
| `/plan` | Plan | Thinking-first — best reasoning model, clarifying questions |
| `/chat` | Chat | Fast conversational — lightweight model, web search only |
| `/moe` | MoE | Mixture of Experts — 3 models discuss your question |

### Shell escape

```
!ls -la                 # Run a command without touching the AI
!git status             # Quick terminal access, inline output
/shell                  # Enter interactive shell mode (exit to return)
```

### Sessions

```
/save my-refactor       # Save conversation
/sessions               # List saved sessions
/resume my-refactor     # Resume where you left off
/sync push              # Sync to WebDAV (Nextcloud, etc.)
```

### Commands

```
/models                 # Browse and switch models
/tools                  # List available tools
/benchmark              # Benchmark all models
/settings               # View/toggle settings (progress bar, model stick)
/copy                   # Copy last response to clipboard
/rc                     # Remote Connect (QR code + URL for phone)
/sandbox                # Manage scratch files
/preview index.html     # Serve HTML in browser
/compact                # Free context space
/init                   # Create VEEPEE.md project instructions
/help                   # Full command list
```

## Tools

### Native (15)

| Category | Tools |
|----------|-------|
| Coding | `read_file`, `write_file`, `edit_file`, `list_files`, `glob`, `grep`, `bash`, `git`, `update_memory` |
| Web | `web_fetch`, `http_request`, `web_search` |
| DevOps | `docker`, `system_info` |
| Agent | `confirm_action` |

### edit_file

The edit tool supports exact match replacement, `replace_all` for bulk changes, and fuzzy whitespace matching that auto-corrects when the model gets indentation wrong — a common issue with local models.

### Remote agent bridge

Connect a remote agent (via `/setup wizard remote` or `vcode.config.json`) to auto-discover and use its tools as native VEEPEE Code tools. The bridge fetches the tool catalog on startup and proxies execution via HTTP.

## Configuration

All configuration lives in `~/.veepee-code/vcode.config.json`. Run `/setup wizard` to configure interactively, or edit the file directly.

Key settings:

| Setting | Description |
|---------|-------------|
| `proxyUrl` | Ollama API endpoint |
| `model` | Force a specific model (null = auto) |
| `autoSwitch` | Auto-switch models by task complexity |
| `modelStick` | Lock model across mode switches |
| `searxngUrl` | SearXNG instance for web search |
| `remote` | Remote agent bridge (`{ url, apiKey }`) |
| `sync` | WebDAV sync (`{ url, user, pass, auto }`) |
| `rc` | Remote Connect (`{ enabled }`) |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit |
| `Shift+Enter` | New line |
| `Ctrl+P` or `/` | Command palette |
| `Tab` | Show tools |
| `Ctrl+Y` | Copy last response to clipboard |
| `Ctrl+C` | Interrupt generation |
| `Ctrl+D` | Quit |
| `Up/Down` | Message history |
| `PgUp/PgDn` | Browse conversation |

## Context management

VEEPEE Code tracks context usage in the status bar (token count and percentage). When context reaches 75%, automatic compaction drops older messages while preserving important context via the knowledge state system.

**Plan persistence:** Implementation plans are automatically detected and saved to `.veepee/plan.md`. After compaction, the plan is restored so the model picks up where it left off. At 90% context, a state snapshot is auto-saved as a safety net.

**Project detection:** On startup, the project type is detected from filesystem markers (tsconfig.json, package.json, pyproject.toml, etc.) and injected into the system prompt with framework-specific coding guidance.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  VEEPEE Code │────>│  Ollama          │────>│  GPU Server  │
│              │     │  (or Fleet Mgr)  │     │              │
│  TUI + Agent │     │                  │────>│  GPU Server  │
│  15 tools    │     │  Load balancing  │     │              │
│  API server  │     │                  │     └──────────────┘
└──────────────┘     └──────────────────┘
```

VEEPEE Code runs on your machine. Inference goes to Ollama (local or remote). Tool execution (files, shell, APIs) stays local. Parallel tool execution for read-only operations (read_file, glob, grep) reduces latency.

## Supported models

Any Ollama model with tool-calling support. The built-in benchmark automatically ranks your models and assigns them to roles — no manual config needed. Tested with:

`qwen3.5:35b` · `qwen3:8b` · `llama3.3:70b` · `deepseek-r1:32b` · `mistral-small:24b` · `gemma3:27b` · `glm-4.7-flash` · `llama3.2-vision`

## CLI flags

```bash
vcode                              # Interactive TUI
vcode -p "explain this codebase"   # Print mode (non-interactive)
vcode -c                           # Continue last session
vcode --resume my-session          # Resume a named session
vcode --wizard                     # Re-run setup wizard
vcode --update                     # Pull latest and rebuild
```

## Testing

```bash
npm test                           # 308 tests across 18 files
```

## License

[MIT](LICENSE)
