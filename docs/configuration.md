---
title: "Configuration"
description: "Complete reference for all environment variables, config files, and project settings."
weight: 3
---

# Configuration

VEEPEE Code keeps its global configuration in two files in `~/.veepee-code/`, and every setting lives in exactly one of them:

| File | Holds |
|------|-------|
| `.env` | Where the models are and every credential: backend, gateway URL, direct server URL, API keys and tokens, search and remote endpoints. Written `0600`. |
| `settings.json` | Everything structured: model choice (`lockModel`, `model`), size limits, `fleet`, `mcpServers`, `hooks`, `lsp`, `remote.allow`, `rc`, and the rest. |

The setup wizard (`vcode --wizard`) writes both; `/setup wizard <step>` edits one step. You can also edit either file by hand: vcode reads them on every start.

Project overrides live in `<project>/.veepee/settings.json` (committed) and `<project>/.veepee/settings.local.json` (gitignored). See [Precedence Summary](#precedence-summary).

## The .env file

`~/.veepee-code/.env` is standard dotenv: `KEY=value`, `#` comments, optional quotes. Only this file is read — a `.env` in your project or in the vcode checkout is not.

| Variable | Setting | Notes |
|----------|---------|-------|
| `VEEPEE_CODE_LLM_BACKEND` | `llmBackend` | `ollama` or `openai` |
| `VEEPEE_CODE_PROXY_URL` | `proxyUrl` | Ollama API / gateway. **Empty** (`VEEPEE_CODE_PROXY_URL=`) means no gateway; absent means `http://localhost:11434`. |
| `VEEPEE_CODE_OPENAI_BASE_URL` | `openaiBaseUrl` | OpenAI-compatible server (vLLM etc.) |
| `VEEPEE_CODE_OPENAI_API_KEY` | `openaiApiKey` | Only if the server was started with `--api-key` |
| `VEEPEE_CODE_DASHBOARD_URL` | `dashboardUrl` | Fleet Manager dashboard |
| `VEEPEE_CODE_API_TOKEN` | `apiToken` | Bearer token for the local API and Remote Connect |
| `SEARXNG_URL` | `searxngUrl` | Enables `web_search` |
| `AGENTLENS_URL` | `agentlensUrl` | Page reader for `web_fetch` |
| `VEEPEE_CODE_REMOTE_URL`, `VEEPEE_CODE_REMOTE_API_KEY` | `remote.url`, `remote.apiKey` | `remote.allow` stays in settings.json |
| `VEEPEE_CODE_SYNC_URL`, `_USER`, `_PASS` | `sync.url`, `.user`, `.pass` | `sync.auto` stays in settings.json |
| `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_HOST` | `langfuse.*` | |

The same variables set in the process environment override the file for one run: `VEEPEE_CODE_PROXY_URL=http://other:11434 vcode`.

If you put one of these settings in `settings.json` by hand, vcode moves it into `.env` on the next start, so it never lives in both files.

A vLLM-only machine, no gateway:

```bash
VEEPEE_CODE_LLM_BACKEND=openai
VEEPEE_CODE_OPENAI_BASE_URL=http://your-gpu-box:8000
VEEPEE_CODE_PROXY_URL=
```

An Ollama machine:

```bash
VEEPEE_CODE_LLM_BACKEND=ollama
VEEPEE_CODE_PROXY_URL=http://localhost:11434
```

The repo ships a commented template at `.env.example`.

## Named agents

The `task` tool can run a named agent: a markdown file giving a role, its tools, optionally a model, and instructions. The format is Claude Code's, so agents written for Claude Code work unchanged. Searched in order, first name wins: `<project>/.veepee/agents/`, `~/.veepee-code/agents/`, `~/.claude/agents/`.

```markdown
---
name: reviewer
description: Reviews a diff for correctness bugs.
tools: Read, Grep, Glob
model: gemma4:26b-a4b
---
You review code changes. Report only real bugs, with file and line.
```

Claude Code tool names (`Read`, `Bash`, `WebFetch`…) map to vcode's; Claude model names (`opus`, `sonnet`, `inherit`) mean "the default subagent model". `tools: []` means no tools.

## Configuration Fields

Each field below is its `settings.json` name. Fields listed in [The .env file](#the-env-file) are set there instead, under their variable name.

### Core (Required)

| Field | Default | Description |
|----------|---------|-------------|
| `proxyUrl` | `http://localhost:11434` | URL of your Ollama proxy or standalone Ollama instance. Required unless you use a direct server with no gateway (`llmBackend: "openai"` and `proxyUrl: ""`; see [No gateway](#no-gateway-direct-server-only)). |
| `dashboardUrl` | `""` | URL of the Ollama Fleet Manager dashboard. Used for enhanced model discovery (loaded models, capabilities, server status). Optional. |
| `fleet` | `[]` | Array of `{name, url}` objects pointing to individual Ollama servers. When non-empty, the benchmark hits each server directly instead of going through the proxy. Used by the `/benchmark` command and `scripts/benchmark.ts`. |

### LLM Backend

By default VEEPEE Code speaks the **Ollama** wire format (`/api/chat`) to `proxyUrl` (typically the llm-gateway). Set `llmBackend` to `"openai"` to instead talk **directly** to a vLLM (or any OpenAI-compatible) server's documented `/v1/chat/completions` route, bypassing the gateway and the Ollama translation entirely.

| Field | Default | Description |
|----------|---------|-------------|
| `llmBackend` | `"ollama"` | Transport for the main agent loop. `"ollama"` → Ollama `/api/chat` via `proxyUrl`. `"openai"` → OpenAI `/v1/chat/completions` at `openaiBaseUrl`. Opt-in; the default preserves existing behavior. |
| `openaiBaseUrl` | `null` | Base URL of the OpenAI-compatible server, e.g. `"http://10.0.154.246:8000"` (a bare host is fine — `/v1` is appended automatically; `".../v1"` is also accepted). Required when `llmBackend` is `"openai"`. Pair with `lockModel` set to a model the server actually serves. |
| `openaiApiKey` | `null` | Bearer token for the OpenAI backend, if it requires one. vLLM usually does not — leave `null`. |

When `llmBackend` is `"openai"`: thinking is toggled via `chat_template_kwargs.enable_thinking`; tool-call `arguments` and the message history are translated to/from the strict `/v1` shape (synthesized `id`/`tool_call_id`, string-encoded arguments); and streaming requests are aborted on interrupt so they are never orphaned. With a `proxyUrl` set, subagents, compaction, model discovery, `/init` and benchmarks go through the gateway; with `proxyUrl` empty they all go to `openaiBaseUrl` (below).

#### Which endpoint serves which model

A direct `openaiBaseUrl` is a **single vLLM server, serving a single model** — in this fleet the DGX serves Qwen3.6 and the AGX serves Gemma 4, and they don't swap. So the agent routes per turn:

| Model for this turn | Goes to |
|---|---|
| The primary (`lockModel`, else `model`) | `openaiBaseUrl` — the direct `/v1` endpoint |
| Anything else (e.g. `reviewModel` via `/review`) | `proxyUrl` — the gateway, which fronts the whole fleet |

Without this, a `/review` turn would send `reviewModel` to the direct endpoint and get a model-not-found, since that server only holds the primary. Falling back to the gateway is never *wrong* — just an extra hop — so an unrecognized model routes there rather than failing. **In this hybrid setup, keep `proxyUrl` valid.**

#### No gateway (direct server only)

A gateway is optional. With `llmBackend: "openai"` and `proxyUrl` set to `""` (or `null`), everything goes to `openaiBaseUrl`: the agent loop, subagents, compaction summaries, `/init` and `/compact`. The model list comes from the server's `GET /v1/models`, so no `lockModel` is needed to start. The setup wizard's **Model Server** step offers this as "Direct server".

```json
{
  "llmBackend": "openai",
  "openaiBaseUrl": "http://your-gpu-box:8000",
  "proxyUrl": ""
}
```

What you give up without a gateway: models the server does not serve (a `reviewModel` or subagent model has to be one it lists), and `/benchmark`, which speaks the Ollama API. An absent `proxyUrl` key still means `http://localhost:11434`; only an explicit `""` or `null` means "no gateway".

### Model Preferences

| Field | Default | Description |
|----------|---------|-------------|
| `numCtx` | `null` | Context window requested from **Ollama** (`num_ctx`). `null` = the model's own maximum (from `/api/show`), capped at 16384. Without it Ollama uses its small default window (4096), which vcode's own prompt overflows. Raise it for long sessions if your GPU has room; OpenAI-compatible servers set their own window and ignore it. |
| `fallbackModels` | `[]` | Models to continue on, in order, when the current one cannot be reached or drops the connection mid-reply, e.g. `["gemma4:26b-a4b"]`. After two failed attempts (about a minute) the step is redone on the next model instead of retrying for up to ten minutes; a model that failed is skipped for two minutes, then tried again. With a gateway, any model it serves works here. |
| `model` | `null` | Force a specific model as default (e.g., `"qwen3.5:35b"`). Overrides the automatic selection algorithm and the model roster. Still switchable at runtime with `/models`. |
| `lockModel` | `null` | **Hard-lock** to one model. When set, VEEPEE Code skips `/api/tags`, skips the tool-support probe, skips the first-launch benchmark, and refuses `/model` and `/models` switches. Use this when your proxy fronts a single-model vLLM endpoint (or anywhere that scanning the full model list is wasteful or destabilizing). Re-run `vcode --wizard-step model` to change. |
| `autoSwitch` | `true` | Enable automatic model switching based on task complexity in act mode. Forced `false` when `lockModel` is set. |
| `maxModelSize` | `40` | Maximum model parameter count in billions. Models larger than this are excluded from auto-selection and benchmark candidacy. |
| `minModelSize` | `12` | Minimum model parameter count in billions for act mode. Models smaller than this are skipped during auto-selection (prevents using tiny unreliable models for coding). |
| `modelStick` | `false` | Lock the current model across mode switches and disable auto-switch. Toggleable at runtime via `/settings model_stick`. Unlike `lockModel`, this is a soft runtime lock that still allows `/model <name>` to switch. |

### API Server

| Field | Default | Description |
|----------|---------|-------------|
| `apiPort` | `8484` | Port for the OpenAI-compatible API server. If the port is in use, VEEPEE Code automatically tries the next port. |
| `apiHost` | `"127.0.0.1"` | API bind address. Set to `"0.0.0.0"` to accept connections from other machines. Automatically widened to `0.0.0.0` when Remote Connect is enabled (unless overridden via `--host`). |
| `apiToken` | `null` | Bearer token for API authentication. When set, all API requests must include an `Authorization: Bearer <token>` header. **Required** when Remote Connect is enabled. |
| `apiExecute` | `false` | Set to `true` to enable the `/api/execute` endpoint, which allows direct tool execution via the API (bypassing permissions). Disabled by default for safety. |

### Web Search

| Field | Default | Description |
|----------|---------|-------------|
| `searxngUrl` | `null` | URL of your SearXNG instance (e.g., `"http://localhost:8888"`). SearXNG is a free, self-hosted metasearch engine. When set, enables the `web_search` tool. Without it, the agent can still use `web_fetch` and `http_request` for direct URL access. |

### Remote Agent Bridge

| Field | Default | Description |
|----------|---------|-------------|
| `remote` | `null` | `{url, apiKey}` object pointing at a remote agent (e.g. [Llama Rider](https://github.com/vpontual/llama_rider)). On startup, VEEPEE Code fetches the remote agent's tool catalog from `${url}/dashboard/api/tools` (Bearer auth) and registers each tool as native. Local tools take priority — collisions are skipped. This is how integrations like Home Assistant, Mastodon, Spotify, Gmail, Calendar, Drive, Docs, Sheets, Tasks, news, weather, and timers are surfaced. |

### Session Sync

| Field | Default | Description |
|----------|---------|-------------|
| `sync` | `null` | `{url, user, pass, auto}` object for WebDAV session sync (Nextcloud, ownCloud, etc.). When set, enables `/sync push|pull|auto|status` commands. `auto: true` pushes after `/save` and pulls before `/sessions`. Uses Node.js built-in `https`/`http` modules — no additional dependencies. |

### Remote Connect

| Field | Default | Description |
|----------|---------|-------------|
| `rc` | `null` | `{enabled: true}` enables the `/rc` web UI endpoints. When enabled, the API server binds to `0.0.0.0` instead of `127.0.0.1` so phones/LAN clients can reach it. **Requires `apiToken` to be set** for authentication. Access at `http://{your-ip}:{port}/rc`. |

### Observability

| Field | Default | Description |
|----------|---------|-------------|
| `langfuse` | `null` | `{secretKey, publicKey, host?}` to enable optional [Langfuse](https://langfuse.com) tracing. Each agent turn is logged as a trace + generation with model, mode, eval counts, tps, latency, and tool calls. Lazy-loaded — failures are silently swallowed and never affect the main loop. |

### Misc

| Field | Default | Description |
|----------|---------|-------------|
| `progressBar` | `true` | Show the bouncing progress bar animation while the agent is working. Toggleable at runtime via `/settings progress-bar`. |
| `shellHistoryContext` | `true` | Capture the last 20 unique commands from `~/.zsh_history` or `~/.bash_history` once on startup and inject them into the system prompt. Set to `false` to disable. |

## Example settings.json

The repo ships an example config at `vcode.config.example.json`:

```json
{
  "proxyUrl": "http://localhost:11434",
  "dashboardUrl": "",
  "lockModel": null,
  "autoSwitch": true,
  "maxModelSize": 40,
  "minModelSize": 12,
  "apiPort": 8484,
  "apiHost": "127.0.0.1",
  "searxngUrl": null,
  "fleet": [
    { "name": "dgx-spark", "url": "http://10.0.154.246:8000" },
    { "name": "orin-agx",  "url": "http://10.0.154.245:8000" },
    { "name": "nano-1",    "url": "http://10.0.154.234:11434" }
  ]
}
```

If your proxy fronts a single-model endpoint (e.g., a vLLM server running one model), set `lockModel` to that model name and VEEPEE Code will stop probing and benchmarking the rest of the fleet:

```json
{
  "proxyUrl": "http://localhost:11434",
  "lockModel": "your-model-name:tag"
}
```

A fuller config with the optional fields might look like:

```json
{
  "proxyUrl": "https://llm-api.casarp.us",
  "dashboardUrl": "https://llm.casarp.us",
  "model": null,
  "autoSwitch": true,
  "maxModelSize": 40,
  "minModelSize": 12,
  "apiPort": 8484,
  "apiHost": "127.0.0.1",
  "apiToken": "your-secret-token",
  "apiExecute": false,
  "searxngUrl": "http://localhost:8888",
  "remote": {
    "url": "http://10.0.153.99:8080",
    "apiKey": "llama-rider-bearer-token"
  },
  "sync": {
    "url": "https://cloud.example.com/remote.php/dav/files/user/veepee-code/",
    "user": "vp",
    "pass": "webdav-password",
    "auto": true
  },
  "rc": { "enabled": true },
  "langfuse": {
    "secretKey": "sk-lf-...",
    "publicKey": "pk-lf-...",
    "host": "http://langfuse.example.com"
  },
  "progressBar": true,
  "modelStick": false,
  "shellHistoryContext": true,
  "fleet": [
    { "name": "dgx-spark", "url": "http://10.0.154.246:8000" },
    { "name": "orin-agx",  "url": "http://10.0.154.245:8000" }
  ]
}
```

## Sandbox for unattended runs

In goal mode (`vcode --goal`, `/goal`) and `--improve`, vcode approves ordinary work without asking. There, shell commands run inside [bubblewrap](https://github.com/containers/bubblewrap): everything stays readable, but only the project, `/tmp` and package-manager caches (`~/.npm`, `~/.cache`, …) are writable, so a wrong command cannot damage anything outside the work it was given. The file tools are already confined to the project. Network access is unchanged.

- `vcode -p` does not sandbox by default (scripts use it for tasks that write elsewhere); set `VCODE_OS_SANDBOX=1` to turn it on.
- `VCODE_NO_OS_SANDBOX=1` turns it off everywhere.
- Linux only. Without bubblewrap, or where it cannot create namespaces, vcode warns once and runs commands unsandboxed.

## Migration

Older installs are converted on the first start of a newer vcode, once:

- **`vcode.config.json` → `settings.json`**: renamed; the old file is kept as `vcode.config.json.bak`.
- **Endpoints and secrets out of `settings.json`**: every setting in the [.env table](#the-env-file) moves into `.env` (a value already in `.env` wins), and the rest of `settings.json` is rewritten without them. A copy is kept as `settings.json.bak-envsplit-<timestamp>`. Installs that relied on the old built-in SearXNG and agentlens addresses get them written into `.env`, since those are no longer defaults.
- **An old all-in-one `.env`** (model, size limits, API port): those settings move to `settings.json`; the endpoints stay in `.env`. The `.env` is no longer renamed away.

## Directory Structure

### ~/.veepee-code/

The home directory stores persistent state:

```
~/.veepee-code/
├── .env                    # Endpoints and secrets (0600)
├── settings.json           # Everything else
├── VEEPEE.md               # Optional global project instructions (loaded for all projects)
├── .veepeignore            # Optional global ignore patterns
├── permissions.json        # Persisted permissions: alwaysAllowed + projectAllowed
├── capabilities.json       # Cached tool-calling probe results per model
├── keybindings.json        # Optional user keybinding overrides
├── output-styles/          # Optional output style/persona markdown files
├── projects.json           # cwd → sessionId mapping for auto-resume
├── sessions/               # Saved conversation sessions
│   ├── abc123-my-refactor.json
│   ├── abc123-state.md     # Knowledge state for that session
│   └── def456-auth-fix.json
├── sandbox/                # Per-session scratch directories (auto-cleaned after 24h)
│   └── {sessionId}/
└── benchmarks/
    ├── roster.json         # Model roster (best model per role)
    ├── latest.json         # Most recent benchmark results
    └── benchmark-2026-03-18T...json  # Timestamped benchmark history
```

### Project Directory

```
your-project/
├── VEEPEE.md               # Project-specific instructions (auto-added to .gitignore by /init)
├── .veepeignore            # Optional project-specific ignore patterns
├── .veepee/
│   ├── plan.md             # Auto-saved implementation plan (survives compaction)
│   └── ralph/              # Ralph engine state files
└── .veepee-worktrees/      # Git worktrees created by /worktree (auto-added to .gitignore)
```

## Precedence Summary

| Setting | Precedence |
|---------|------------|
| Settings | Lowest to highest: `~/.veepee-code/settings.json` < `~/.veepee-code/.env` < `.veepee/settings.json` < `.veepee/settings.local.json` < process environment. CLI flags (`--host`, `--port`) override the corresponding fields at runtime. |
| `VEEPEE.md` | Workspace > Parent directories (up to 5 levels) > Global (`~/.veepee-code/VEEPEE.md`) — all included with source annotations |
| `.veepeignore` | Project `.veepeignore` is processed after global `~/.veepee-code/.veepeignore`. Default protected patterns (`.env`, `*.pem`, `*.key`, etc.) are always loaded first. Negation with `!pattern` re-allows. |
| Permissions | Dangerous patterns (always prompt) → safe-tool allowlist (auto) → project-scoped (`tool:cwd`) → persisted always-allow → session grants → prompt |
| Benchmarks | Roster at `~/.veepee-code/benchmarks/roster.json`, latest results at `latest.json`, full history as timestamped files |
| Sessions | JSON files at `~/.veepee-code/sessions/` |
