---
title: "Overview"
description: "What is VEEPEE Code, key features, and how it compares to other AI coding CLIs."
weight: 1
---

# VEEPEE Code

VEEPEE Code is an AI coding assistant that runs entirely on your own hardware. It connects to your local [Ollama](https://ollama.com/) fleet through the [Ollama Fleet Manager](https://github.com/vpontual/llm-traffic-manager) proxy, giving you a Claude Code-style terminal experience with zero API costs, full data privacy, and 25+ integrated tools.

```
██╗     ██╗      █████╗ ███╗   ███╗ █████╗
██║     ██║     ██╔══██╗████╗ ████║██╔══██╗
██║     ██║     ███████║██╔████╔██║███████║
██║     ██║     ██╔══██║██║╚██╔╝██║██╔══██║
███████╗███████╗██║  ██║██║ ╚═╝ ██║██║  ██║
╚══════╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝

 ██████╗ ██████╗ ██████╗ ███████╗
██╔════╝██╔═══██╗██╔══██╗██╔════╝
██║     ██║   ██║██║  ██║█████╗
██║     ██║   ██║██║  ██║██╔══╝
╚██████╗╚██████╔╝██████╔╝███████╗
 ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
```

## Key Features

- **Zero API Cost** -- Every inference runs on your own GPUs. No API keys, no metered billing, no data leaving your network.

- **25+ Integrated Tools** -- File operations, shell commands, git, Docker, web search, Home Assistant, Mastodon, Spotify, Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Tasks), news feeds, and more.

- **Automatic Model Switching** -- The agent evaluates task complexity in real-time and switches between heavy (25B+), standard (6-25B), and light (<6B) models as needed. Simple questions get fast answers; complex refactors get the best available model.

- **Three Operating Modes** -- `/act` for execution, `/plan` for thinking-first architecture and design, `/chat` for conversational web-connected Q&A. Plan mode auto-activates when it detects planning intent in your message.

- **Knowledge Cutoff Awareness** -- The system prompt embeds each model's training data cutoff date and instructs the model to verify post-cutoff facts via web search before answering. No stale information.

- **Built-in Benchmarking** -- Run `/benchmark` to test all your models across tool calling, code generation, code editing, instruction following, and reasoning. Results include context window probing and tokens-per-second measurements.

- **Permission System** -- Safe tools (read-only operations) run automatically. Dangerous operations (destructive shell commands, social media posts, device control, email sending) prompt for explicit approval. Permissions can be granted per-session or persisted permanently.

- **OpenAI-Compatible API** -- An HTTP server on port 8484 exposes chat completions, model listing, tool execution, and status endpoints. Other tools like Claude Code, Gemini CLI, or custom scripts can use VEEPEE Code as a backend.

- **Full-Screen TUI** -- Alternate-screen terminal UI with ASCII art logo, input box, turn tracker (agent tree view showing tool calls in progress), streaming output, thinking display, and a status bar.

- **VEEPEE.md Project Instructions** -- Like CLAUDE.md or AGENTS.md, you can create a VEEPEE.md file with project-specific instructions that get injected into every system prompt. Supports hierarchical loading (workspace > parent > global).

## How It Differs

### vs. Claude Code

Claude Code requires a paid Anthropic API subscription. VEEPEE Code runs on your own Ollama instances -- any model, any hardware, zero ongoing cost. Claude Code has more sophisticated context management and a larger model behind it, but VEEPEE Code compensates with multi-model auto-switching and local infrastructure integration (Home Assistant, Mastodon, Spotify, etc.).

### vs. OpenCode

OpenCode connects to cloud providers (OpenAI, Anthropic, Google) or local Ollama. VEEPEE Code is purpose-built for Ollama fleet management with proxy-aware model discovery, multi-server load balancing, and built-in benchmarking. OpenCode has a polished TUI with markdown rendering; VEEPEE Code has a comparable full-screen interface with agent tree view and streaming.

### vs. Gemini CLI

Gemini CLI is Google's free offering tied to the Gemini model family. VEEPEE Code supports any model available through Ollama (Qwen, Llama, Mistral, DeepSeek, Gemma, Phi, Command-R, etc.) and adds the auto-switching intelligence to pick the right model for each task. Gemini CLI has no local-only option.

### vs. GitHub Copilot CLI

Copilot CLI focuses on shell command generation and explanation. VEEPEE Code is a full agent with file editing, multi-turn conversations, web search, and 25+ tool categories. Copilot CLI requires a GitHub subscription.

## Requirements

- **Node.js** 20 or later
- **Ollama** running on at least one machine in your network
- **Ollama Fleet Manager** proxy (recommended but not required -- VEEPEE Code can connect to a standalone Ollama instance)

## Architecture at a Glance

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────┐
│  VEEPEE Code  │────▶│  Ollama Proxy     │────▶│  GPU Server │
│  (your Mac)  │     │  (fleet manager)  │     │  (DGX/AGX)  │
│              │     │                   │────▶│  GPU Server  │
│  TUI + Agent │     │  Load balancing   │     │  (Nano/etc) │
│  25+ tools   │     │  Model routing    │     └─────────────┘
│  API :8484   │     │  Dashboard :3334  │
└──────────────┘     └──────────────────┘
```

The agent runs locally on your development machine. It sends inference requests to the Ollama proxy, which routes them to the appropriate GPU server based on model availability, server load, and affinity rules. Tool execution (file I/O, shell commands, API calls) happens locally on the machine where VEEPEE Code is running.
