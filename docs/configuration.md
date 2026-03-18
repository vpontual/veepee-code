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
| `VEEPEE_CODE_PROXY_URL` | `http://10.0.153.99:11434` | URL of your Ollama proxy or standalone Ollama instance. This is the only truly required setting. |
| `VEEPEE_CODE_DASHBOARD_URL` | `http://10.0.153.99:3334` | URL of the Ollama Fleet Manager dashboard. Used for model discovery (loaded models, capabilities, server status). |

### Model Preferences (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `VEEPEE_CODE_MODEL` | *(auto-selected)* | Force a specific model as default (e.g., `qwen3.5:35b`). Overrides the automatic selection algorithm. |
| `VEEPEE_CODE_AUTO_SWITCH` | `true` | Enable automatic model switching based on task complexity. Set to `false` to lock to the selected model. |
| `VEEPEE_CODE_MAX_TURNS` | `50` | Maximum number of agent loop iterations per user message. Each iteration can include LLM inference and tool execution. Prevents runaway loops. |

### API Server (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `VEEPEE_CODE_API_PORT` | `8484` | Port for the OpenAI-compatible API server. If the port is in use, VEEPEE Code automatically tries the next port. |

### Home Assistant (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `HA_URL` | *(none)* | Home Assistant base URL (e.g., `http://10.0.153.90:8123`). |
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
| `SEARXNG_URL` | *(none)* | URL of your SearXNG instance (e.g., `http://10.0.153.99:8888`). SearXNG is a free, self-hosted metasearch engine. |

Must be set to enable the `web_search` tool. Without it, the agent can still use `web_fetch` and `http_request` for direct URL access.

### News (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `NEWSFEED_URL` | *(none)* | URL of the AI-optimized newsfeed API (e.g., `http://10.0.153.99:3333`). |

Must be set to enable the `news` tool.

## Example .env File

```bash
# Ollama Proxy (required)
VEEPEE_CODE_PROXY_URL=http://10.0.153.99:11434
VEEPEE_CODE_DASHBOARD_URL=http://10.0.153.99:3334

# Model preferences (optional)
VEEPEE_CODE_MODEL=                # Leave empty for auto-selection
VEEPEE_CODE_AUTO_SWITCH=true
VEEPEE_CODE_MAX_TURNS=50

# API port
VEEPEE_CODE_API_PORT=8484

# Home Assistant
HA_URL=http://10.0.153.90:8123
HA_TOKEN=eyJ0eXAiOiJKV1QiLCJh...

# Mastodon
MASTODON_URL=https://mastodon.social
MASTODON_TOKEN=abc123...

# Spotify
SPOTIFY_CLIENT_ID=your-client-id
SPOTIFY_CLIENT_SECRET=your-client-secret
SPOTIFY_REFRESH_TOKEN=AQD...

# Google Workspace
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REFRESH_TOKEN=1//0e...

# Web Search (SearXNG)
SEARXNG_URL=http://10.0.153.99:8888

# News
NEWSFEED_URL=http://10.0.153.99:3333
```

## Directory Structure

### ~/.veepee-code/

The home directory stores persistent state:

```
~/.veepee-code/
├── .env                    # Global config (alternative location)
├── VEEPEE.md                # Global project instructions (loaded for all projects)
├── permissions.json        # Persisted "always allow" tool permissions
└── benchmarks/
    ├── latest.json         # Most recent benchmark results
    └── benchmark-2026-03-18T...json  # Timestamped benchmark history
```

### ~/.config/veepee-code/

XDG-compliant config location:

```
~/.config/veepee-code/
└── .env                    # Global config (preferred location)
```

### Project Directory

```
your-project/
├── .env                    # Project-local config (overrides global)
└── VEEPEE.md                # Project-specific instructions
```

## Config Precedence Summary

| Setting | Precedence |
|---------|------------|
| `.env` file | Local `.env` > `~/.veepee-code/.env` > `~/.config/veepee-code/.env` > default dotenv |
| `VEEPEE.md` | Workspace > Parent directories (up to 5 levels) > Global (`~/.veepee-code/VEEPEE.md`) |
| Permissions | Persisted always-allow (`~/.veepee-code/permissions.json`) + session grants |
| Benchmarks | Latest results at `~/.veepee-code/benchmarks/latest.json` |
