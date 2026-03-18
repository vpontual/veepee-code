---
title: "Overview"
description: "What is VEEPEE Code, key features, and how it compares to other AI coding CLIs."
weight: 1
---

# VEEPEE Code

VEEPEE Code is an AI coding assistant that runs entirely on your own hardware. It connects to your local [Ollama](https://ollama.com/) instance (or an [Ollama Fleet Manager](https://github.com/vpontual/llm-traffic-manager) proxy), giving you a Claude Code-style terminal experience with zero API costs, full data privacy, and 25 integrated tools.

```
██╗   ██╗███████╗███████╗██████╗ ███████╗███████╗
██║   ██║██╔════╝██╔════╝██╔══██╗██╔════╝██╔════╝
██║   ██║█████╗  █████╗  ██████╔╝█████╗  █████╗
╚██╗ ██╔╝██╔══╝  ██╔══╝  ██╔═══╝ ██╔══╝  ██╔══╝
 ╚████╔╝ ███████╗███████╗██║     ███████╗███████╗
  ╚═══╝  ╚══════╝╚══════╝╚═╝     ╚══════╝╚══════╝

          ██████╗ ██████╗ ██████╗ ███████╗
         ██╔════╝██╔═══██╗██╔══██╗██╔════╝
         ██║     ██║   ██║██║  ██║█████╗
         ██║     ██║   ██║██║  ██║██╔══╝
         ╚██████╗╚██████╔╝██████╔╝███████╗
          ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
```

## Key Features

- **Zero API Cost** -- Every inference runs on your own GPUs. No API keys, no metered billing, no data leaving your network.

- **25 Integrated Tools** -- File operations, shell commands, git, Docker, web search, Home Assistant, Mastodon, Spotify, Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Tasks), news feeds, and more.

- **Smart Benchmark & Model Roster** -- On first launch, VEEPEE Code runs a smart benchmark inside the TUI. It discovers all models with tool support, tests their responsiveness (tok/s with a 60-second cold-start allowance), then runs a full benchmark on responsive models. Results are used to build a **model roster** -- the best model for each role: act (default coding), plan (best reasoning), chat (fastest conversational), code (best code gen + editing), and search (fastest for sub-agents). The roster is saved to `~/.veepee-code/benchmarks/roster.json` and drives all mode switching.

- **Configurable Model Size Limits** -- Set `VEEPEE_CODE_MAX_MODEL_SIZE` and `VEEPEE_CODE_MIN_MODEL_SIZE` to control which models the agent considers. No arbitrary tier system -- the benchmark measures actual performance.

- **Three Operating Modes** -- `/act` for execution (uses roster's act model), `/plan` for thinking-first architecture and design (uses roster's plan model), `/chat` for conversational web-connected Q&A (uses roster's chat model). Plan mode auto-activates when it detects planning intent in your message.

- **Session Management** -- Save conversations with `/save`, list them with `/sessions`, and resume with `/resume` or the `--resume` CLI flag. Sessions are stored as JSON at `~/.veepee-code/sessions/`.

- **Knowledge Cutoff Awareness** -- The system prompt embeds each model's training data cutoff date and instructs the model to verify post-cutoff facts via web search before answering. No stale information.

- **Permission System** -- Safe tools (read-only operations) run automatically. Dangerous operations (destructive shell commands, social media posts, device control, email sending) prompt for explicit approval with y/a/n. Permissions can be granted per-session or persisted permanently at `~/.veepee-code/permissions.json`.

- **OpenAI-Compatible API** -- An HTTP server on port 8484 exposes chat completions, model listing, tool execution, and status endpoints with streaming SSE support and `veepee_code` custom extensions. Other tools like Claude Code, Gemini CLI, or custom scripts can use VEEPEE Code as a backend.

- **Full-Screen TUI** -- Alternate-screen terminal UI with block-pixel "VEEPEE CODE" logo, user messages with highlighted background and blue border, markdown rendering via marked-terminal, command palette on `/`, turn tracker showing tool calls with live progress, streaming output, thinking display, blinking cursor in the input box, and a status bar.

- **VEEPEE.md Project Instructions** -- Like CLAUDE.md or AGENTS.md, you can create a VEEPEE.md file (via `/init`) with project-specific instructions that get injected into every system prompt. Supports hierarchical loading (workspace > parent > global). Automatically added to `.gitignore`.

## How It Differs

### vs. Claude Code

Claude Code requires a paid Anthropic API subscription. VEEPEE Code runs on your own Ollama instances -- any model, any hardware, zero ongoing cost. Claude Code has more sophisticated context management and a larger model behind it, but VEEPEE Code compensates with benchmark-driven model roster selection and local infrastructure integration (Home Assistant, Mastodon, Spotify, etc.).

### vs. OpenCode

OpenCode connects to cloud providers (OpenAI, Anthropic, Google) or local Ollama. VEEPEE Code is purpose-built for Ollama fleet management with proxy-aware model discovery, multi-server load balancing, and built-in benchmarking that builds an optimal model roster. OpenCode has a polished TUI with markdown rendering; VEEPEE Code has a comparable full-screen interface with agent tree view, markdown rendering via marked-terminal, and streaming.

### vs. Gemini CLI

Gemini CLI is Google's free offering tied to the Gemini model family. VEEPEE Code supports any model available through Ollama (Qwen, Llama, Mistral, DeepSeek, Gemma, Phi, Command-R, etc.) and adds benchmark-driven intelligence to pick the right model for each role. Gemini CLI has no local-only option.

### vs. GitHub Copilot CLI

Copilot CLI focuses on shell command generation and explanation. VEEPEE Code is a full agent with file editing, multi-turn conversations, web search, session persistence, and 25 tool categories. Copilot CLI requires a GitHub subscription.

## Requirements

- **Node.js** 20 or later
- **Ollama** running on at least one machine in your network
- **Ollama Fleet Manager** proxy (optional -- VEEPEE Code works with a standalone Ollama instance at `localhost:11434`)

## Architecture at a Glance

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────┐
│  VEEPEE Code  │────▶│  Ollama Proxy     │────▶│  GPU Server │
│  (your Mac)  │     │  (fleet manager)  │     │  (DGX/AGX)  │
│              │     │                   │────▶│  GPU Server  │
│  TUI + Agent │     │  Load balancing   │     │  (Nano/etc) │
│  25 tools    │     │  Model routing    │     └─────────────┘
│  API :8484   │     │  Dashboard :3334  │
└──────────────┘     └──────────────────┘
```

The agent runs locally on your development machine. It sends inference requests to the Ollama proxy (or directly to Ollama at `localhost:11434`), which routes them to the appropriate GPU server based on model availability, server load, and affinity rules. Tool execution (file I/O, shell commands, API calls) happens locally on the machine where VEEPEE Code is running.
