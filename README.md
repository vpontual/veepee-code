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

Any Ollama model with tool-calling support. The built-in benchmark automatically ranks your models and assigns them to roles — no manual config needed.

### Benchmark results

Results from a full fleet benchmark (2026-04-04). The benchmark runs 12 tests across 5 categories: tool calling (30%), code generation (25%), code editing (15%), instruction following (15%), reasoning (15%). Models below 8 tok/s or without tool support are filtered out automatically.

| Model | Server | Overall | Tools | CodeGen | Edit | Follow | Reason | tok/s |
|---|---|---|---|---|---|---|---|---|
| qwen3-coder-next:tools | dgx-spark | **100** | 100 | 100 | 100 | 100 | 100 | 29 |
| qwen3-coder-next:latest | dgx-spark | **100** | 100 | 100 | 100 | 100 | 100 | 29 |
| gpt-oss:120b | dgx-spark | **100** | 100 | 100 | 100 | 100 | 100 | 21 |
| mistral-small3.2:24b | orin-agx | **100** | 100 | 100 | 100 | 100 | 100 | 8 |
| lfm2:latest | orin-agx | 99 | 100 | 100 | 100 | 100 | 90 | 29 |
| gpt-oss:20b-16k | orin-agx | 99 | 100 | 100 | 100 | 100 | 93 | 16 |
| gpt-oss:20b | dgx-spark | 93 | 100 | 100 | 100 | 100 | 50 | 23 |
| qwen2.5:14b | dgx-spark | 91 | 71 | 100 | 100 | 100 | 100 | 17 |
| qwen2.5:14b | orin-agx | 91 | 71 | 100 | 100 | 100 | 100 | 11 |
| gpt-oss:20b | orin-agx | 89 | 100 | 57 | 100 | 100 | 100 | 13 |
| llama4:latest | dgx-spark | 84 | 100 | 100 | 0 | 100 | 93 | 12 |
| llama3.2:3b | dgx-spark | 82 | 100 | 100 | 0 | 94 | 83 | 55 |
| llama3.2:3b | orin-agx | 82 | 100 | 100 | 0 | 94 | 83 | 28 |
| llama3.2:3b | nano-1 | 82 | 100 | 100 | 0 | 94 | 83 | 18 |
| qwen2.5:3b-instruct | nano-1 | 80 | 94 | 87 | 0 | 100 | 100 | 20 |

Full results (all servers + proxy) in [`benchmarks/results.json`](benchmarks/results.json).

**Filtered out:** Models without tool-calling support (`qwen3.5`, `qwen3`, `gemma3`, `glm-4.7-flash`, `deepseek-r1`, `gemma4:26b`, etc.) and models below 8 tok/s (`gemma4:31b` at 0 tok/s, `nemotron-cascade-2` at 0 tok/s).

### Benchmarking your fleet

Run `scripts/benchmark.ts` to benchmark all servers in your fleet config. Results are saved to `~/.veepee-code/benchmarks/latest.json` and `benchmarks/results.json` in the repo.

```bash
# Benchmark all fleet servers (8 tok/s floor, skip already-benchmarked)
npx tsx scripts/benchmark.ts

# Options
npx tsx scripts/benchmark.ts --list              # show saved results
npx tsx scripts/benchmark.ts --force             # re-run everything
npx tsx scripts/benchmark.ts --server dgx-spark  # one server only
npx tsx scripts/benchmark.ts --min-tps=0         # disable speed filter
```

Configure fleet servers in `~/.veepee-code/vcode.config.json`:

```json
"fleet": [
  { "name": "dgx-spark", "url": "http://10.0.154.246:11434" },
  { "name": "orin-agx",  "url": "http://10.0.154.245:11434" }
]
```

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
