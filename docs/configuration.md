---
title: "Configuration"
description: "Complete reference for all environment variables, config files, and project settings."
weight: 3
---

# Configuration

VEEPEE Code uses environment variables for configuration, loaded from `.env` files. It also supports project-specific instruction files (VEEPEE.md) and stores persistent state in the `~/.veepee-code/` directory.

## .env File Locations

VEEPEE Code checks for `.env` files in this order (first match wins):

1. **Project-local** -- `.env` in the current working directory
2. **Home directory** -- `~/.veepee-code/.env`
3. **XDG config** -- `~/.config/veepee-code/.env`
4. **Default dotenv** -- Standard dotenv file discovery

> **Note:** Only one `.env` file is loaded. If you have a project-local `.env`, the global config is not merged in. Keep proxy settings in the global config and override only what you need locally.

## Environment Variables

### Core (Required)

| Variable | Default | Description |
|----------|---------|-------------|
| `VEEPEE_CODE_PROXY_URL` | `http://localhost:11434` | URL of your Ollama proxy or standalone Ollama instance. This is the only truly required setting. |
| `VEEPEE_CODE_DASHBOARD_URL` | *(empty)* | URL of the Ollama Fleet Manager dashboard. Used for enhanced model discovery (loaded models, capabilities, server status). Optional -- VEEPEE Code works without it. |

### Model Preferences (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `VEEPEE_CODE_MODEL` | *(auto-selected)* | Force a specific model as default (e.g., `qwen3.5:35b`). Overrides the automatic selection algorithm and the model roster. |
| `VEEPEE_CODE_AUTO_SWITCH` | `true` | Enable automatic model switching based on task complexity. Set to `false` to lock to the selected model. |
| `VEEPEE_CODE_MAX_MODEL_SIZE` | `40` | Maximum model parameter count in billions. Models larger than this are excluded from auto-selection and benchmark candidacy. |
| `VEEPEE_CODE_MIN_MODEL_SIZE` | `6` | Minimum model parameter count in billions for act mode. Models smaller than this are skipped during auto-selection (prevents using tiny unreliable models for coding). |
| `VEEPEE_CODE_MAX_TURNS` | `50` | Maximum number of agent loop iterations per user message. Each iteration can include LLM inference and tool execution. Prevents runaway loops. |

### API Server (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `VEEPEE_CODE_API_PORT` | `8484` | Port for the OpenAI-compatible API server. If the port is in use, VEEPEE Code automatically tries the next port. |

### Home Assistant (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `HA_URL` | *(none)* | Home Assistant base URL (e.g., `http://your-ha-server:8123`). |
| `HA_TOKEN` | *(none)* | Long-lived access token from Home Assistant. Generate one at Settings > Security > Long-lived access tokens. |

Both `HA_URL` and `HA_TOKEN` must be set to enable the `home_assistant` and `timer` tools.

### Mastodon (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `MASTODON_URL` | *(none)* | Your Mastodon instance URL (e.g., `https://mx.pontual.social`). |
| `MASTODON_TOKEN` | *(none)* | Mastodon access token with `read`, `write`, and `follow` scopes. Generate one at Preferences > Development > New application. |

Both must be set to enable the `mastodon` tool.

### Spotify (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `SPOTIFY_CLIENT_ID` | *(none)* | Spotify app client ID from the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). |
| `SPOTIFY_CLIENT_SECRET` | *(none)* | Spotify app client secret. |
| `SPOTIFY_REFRESH_TOKEN` | *(none)* | OAuth2 refresh token. Obtain via the Authorization Code flow with `user-read-currently-playing`, `user-modify-playback-state`, `user-read-recently-played` scopes. |

All three must be set to enable the `spotify` tool.

### Google Workspace (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` | *(none)* | Google OAuth2 client ID from the [Google Cloud Console](https://console.cloud.google.com/). |
| `GOOGLE_CLIENT_SECRET` | *(none)* | Google OAuth2 client secret. |
| `GOOGLE_REFRESH_TOKEN` | *(none)* | OAuth2 refresh token with Gmail, Calendar, Drive, Docs, Sheets, and Tasks scopes. |

All three must be set to enable the `email`, `calendar`, `google_drive`, `google_docs`, `google_sheets`, and `notes` tools.

Required OAuth scopes:
- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/drive`
- `https://www.googleapis.com/auth/documents`
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/tasks`

### Web Search (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARXNG_URL` | *(none)* | URL of your SearXNG instance (e.g., `http://localhost:8888`). SearXNG is a free, self-hosted metasearch engine. |

Must be set to enable the `web_search` tool. Without it, the agent can still use `web_fetch` and `http_request` for direct URL access.

### News (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `NEWSFEED_URL` | *(none)* | URL of the AI-optimized newsfeed API (e.g., `http://localhost:3333`). |

Must be set to enable the `news` tool.

## Example .env File

The installer creates `~/.veepee-code/.env` with this template:

```bash
# ─── Ollama Connection (required) ─────────────────────────────────────────────
# Point to your Ollama server or Ollama Fleet Manager proxy
VEEPEE_CODE_PROXY_URL=http://localhost:11434
# VEEPEE_CODE_DASHBOARD_URL=  # Only if using Ollama Fleet Manager

# ─── Model Preferences ────────────────────────────────────────────────────────
VEEPEE_CODE_AUTO_SWITCH=true
VEEPEE_CODE_MAX_MODEL_SIZE=40
VEEPEE_CODE_MIN_MODEL_SIZE=6

# ─── API Server ───────────────────────────────────────────────────────────────
VEEPEE_CODE_API_PORT=8484

# ─── Optional Integrations ────────────────────────────────────────────────────
# Run /setup inside vcode to see which integrations are available.
# Uncomment and fill in tokens for the ones you want.

# Home Assistant
# HA_URL=http://your-ha-server:8123
# HA_TOKEN=

# Mastodon
# MASTODON_URL=https://your.mastodon.instance
# MASTODON_TOKEN=

# Spotify (https://developer.spotify.com/dashboard)
# SPOTIFY_CLIENT_ID=
# SPOTIFY_CLIENT_SECRET=
# SPOTIFY_REFRESH_TOKEN=

# Google Workspace (https://console.cloud.google.com)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REFRESH_TOKEN=

# SearXNG web search (https://docs.searxng.org)
# SEARXNG_URL=http://localhost:8888

# AI Newsfeed
# NEWSFEED_URL=http://localhost:3333
```

## Directory Structure

### ~/.veepee-code/

The home directory stores persistent state:

```
~/.veepee-code/
├── .env                    # Global config
├── VEEPEE.md               # Global project instructions (loaded for all projects)
├── permissions.json        # Persisted "always allow" tool permissions
├── sessions/               # Saved conversation sessions
│   ├── abc123-my-refactor.json
│   └── def456-auth-fix.json
└── benchmarks/
    ├── roster.json         # Model roster (best model per role)
    ├── latest.json         # Most recent benchmark results
    └── benchmark-2026-03-18T...json  # Timestamped benchmark history
```

### ~/.config/veepee-code/

XDG-compliant config location (alternative to `~/.veepee-code/.env`):

```
~/.config/veepee-code/
└── .env                    # Global config (alternative location)
```

### Project Directory

```
your-project/
├── .env                    # Project-local config (overrides global)
└── VEEPEE.md               # Project-specific instructions
```

## Config Precedence Summary

| Setting | Precedence |
|---------|------------|
| `.env` file | Local `.env` > `~/.veepee-code/.env` > `~/.config/veepee-code/.env` > default dotenv |
| `VEEPEE.md` | Workspace > Parent directories (up to 5 levels) > Global (`~/.veepee-code/VEEPEE.md`) |
| Permissions | Persisted always-allow (`~/.veepee-code/permissions.json`) + session grants |
| Benchmarks | Roster at `~/.veepee-code/benchmarks/roster.json`, results at `latest.json` |
| Sessions | Stored at `~/.veepee-code/sessions/` as JSON files |
