---
title: "Configuration"
description: "Complete reference for all environment variables, config files, and project settings."
weight: 3
---

# Configuration

VEEPEE Code stores its configuration in `~/.veepee-code/vcode.config.json`. (Earlier versions used `~/.veepee-code/.env`; on first launch, any existing `.env` is automatically migrated to JSON and renamed to `.env.backup`.) It also supports project-specific instruction files (VEEPEE.md) and stores persistent state in the `~/.veepee-code/` directory.

The setup wizard (`vcode --wizard`) is the easiest way to configure everything interactively. You can also edit the JSON file directly.

## Config File Location

```
~/.veepee-code/vcode.config.json
```

A starter file lives in the repo at `vcode.config.example.json`. Project-local overrides are not currently supported in the JSON-based config — settings live in one place per machine.

## Configuration Fields

All fields below live in `~/.veepee-code/vcode.config.json`. Run `vcode --wizard` to set them interactively, or edit the file directly.

### Core (Required)

| Field | Default | Description |
|----------|---------|-------------|
| `proxyUrl` | `http://localhost:11434` | URL of your Ollama proxy or standalone Ollama instance. The only truly required setting. |
| `dashboardUrl` | `""` | URL of the Ollama Fleet Manager dashboard. Used for enhanced model discovery (loaded models, capabilities, server status). Optional. |
| `fleet` | `[]` | Array of `{name, url}` objects pointing to individual Ollama servers. When non-empty, the benchmark hits each server directly instead of going through the proxy. Used by the `/benchmark` command and `scripts/benchmark.ts`. |

### LLM Backend

By default VEEPEE Code speaks the **Ollama** wire format (`/api/chat`) to `proxyUrl` (typically the llm-gateway). Set `llmBackend` to `"openai"` to instead talk **directly** to a vLLM (or any OpenAI-compatible) server's documented `/v1/chat/completions` route, bypassing the gateway and the Ollama translation entirely.

| Field | Default | Description |
|----------|---------|-------------|
| `llmBackend` | `"ollama"` | Transport for the main agent loop. `"ollama"` → Ollama `/api/chat` via `proxyUrl`. `"openai"` → OpenAI `/v1/chat/completions` at `openaiBaseUrl`. Opt-in; the default preserves existing behavior. |
| `openaiBaseUrl` | `null` | Base URL of the OpenAI-compatible server, e.g. `"http://10.0.154.246:8000"` (a bare host is fine — `/v1` is appended automatically; `".../v1"` is also accepted). Required when `llmBackend` is `"openai"`. Pair with `lockModel` set to a model the server actually serves. |
| `openaiApiKey` | `null` | Bearer token for the OpenAI backend, if it requires one. vLLM usually does not — leave `null`. |

When `llmBackend` is `"openai"`: thinking is toggled via `chat_template_kwargs.enable_thinking`; tool-call `arguments` and the message history are translated to/from the strict `/v1` shape (synthesized `id`/`tool_call_id`, string-encoded arguments); and streaming requests are aborted on interrupt so they are never orphaned. The subagent (`task` tool) and model-discovery paths still use `proxyUrl`, so keep it valid as a fallback.

### Model Preferences

| Field | Default | Description |
|----------|---------|-------------|
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

## Example .env File

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

## Migration from .env

Earlier VEEPEE Code versions used `~/.veepee-code/.env`. On first launch, `loadConfig()` calls `migrateEnvToJson()` which:

1. Checks for `~/.veepee-code/.env`
2. Parses the env vars (`VEEPEE_CODE_PROXY_URL`, `VEEPEE_CODE_DASHBOARD_URL`, `VEEPEE_CODE_MODEL`, `VEEPEE_CODE_AUTO_SWITCH`, `VEEPEE_CODE_MAX_MODEL_SIZE`, `VEEPEE_CODE_MIN_MODEL_SIZE`, `VEEPEE_CODE_API_PORT`, `VEEPEE_CODE_API_HOST`, `VEEPEE_CODE_API_TOKEN`, `VEEPEE_CODE_API_EXECUTE`, `SEARXNG_URL`, `VEEPEE_CODE_SYNC_*`, `VEEPEE_CODE_RC_ENABLED`, `VEEPEE_CODE_REMOTE_*`)
3. Writes them to `vcode.config.json` in the new structured format
4. Renames the old `.env` to `.env.backup`

This is a one-time migration. New installs go straight to JSON.

## Directory Structure

### ~/.veepee-code/

The home directory stores persistent state:

```
~/.veepee-code/
├── vcode.config.json       # Main configuration
├── .env.backup             # (only if migrated from older versions)
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
| `vcode.config.json` | Single file at `~/.veepee-code/vcode.config.json`. CLI flags (`--host`, `--port`) override the corresponding fields at runtime. |
| `VEEPEE.md` | Workspace > Parent directories (up to 5 levels) > Global (`~/.veepee-code/VEEPEE.md`) — all included with source annotations |
| `.veepeignore` | Project `.veepeignore` is processed after global `~/.veepee-code/.veepeignore`. Default protected patterns (`.env`, `*.pem`, `*.key`, etc.) are always loaded first. Negation with `!pattern` re-allows. |
| Permissions | Dangerous patterns (always prompt) → safe-tool allowlist (auto) → project-scoped (`tool:cwd`) → persisted always-allow → session grants → prompt |
| Benchmarks | Roster at `~/.veepee-code/benchmarks/roster.json`, latest results at `latest.json`, full history as timestamped files |
| Sessions | JSON files at `~/.veepee-code/sessions/` |
