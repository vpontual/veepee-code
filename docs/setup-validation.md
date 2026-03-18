---
title: "Setup Validation"
description: "The /setup command, integration status, required environment variables, and troubleshooting."
weight: 10
---

# Setup Validation

The `/setup` command tests connectivity to all external integrations and reports their status. Use it to verify your configuration, diagnose connection issues, and see which tools are available.

## Running Setup

```
/setup
```

The command tests each integration in sequence with a 5-second timeout per connection. Results are displayed in three groups: active, needs configuration, and errors.

## Integration Status Report

### Example Output

```
  Integration Status

  ✓ Active (8):
    ● Filesystem [read_file, write_file, edit_file, list_files, glob, grep] — Always available
    ● Shell & Git [bash, git] — Always available
    ● Docker [docker] — Always available (requires Docker installed)
    ● System Info [system_info] — Always available
    ● Weather [weather] — Open-Meteo (free, no key needed)
    ● Web Fetch & HTTP [web_fetch, http_request] — Always available
    ● Ollama Proxy — Connected — 47 models available
    ● Web Search (SearXNG) [web_search] — Connected

  ○ Needs Configuration (3):
    ○ Mastodon [mastodon]
      Set MASTODON_URL and MASTODON_TOKEN in .env
    ○ Spotify [spotify]
      Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN in .env
    ○ Google Workspace [email, calendar, google_drive, google_docs, google_sheets, notes]
      Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in .env

  ✗ Errors (1):
    ✗ Newsfeed [news] — Cannot connect to http://10.0.153.99:3333

  20/25 tools active  |  Config: ~/.veepee-code/.env or ./.env
```

### Status Categories

| Status | Icon | Meaning |
|--------|------|---------|
| **Active** | ● (green) | Integration is configured and responding. All associated tools are available. |
| **Needs Configuration** | ○ (yellow) | Required environment variables are not set. The tools are registered but will not appear in the agent's tool list. |
| **Error** | ✗ (red) | Configuration is present but the service is unreachable or returning errors. Check the URL, token, and network connectivity. |

## Integrations Reference

### Always Available (No Configuration Needed)

| Integration | Category | Tools | Notes |
|-------------|----------|-------|-------|
| Filesystem | Coding | `read_file`, `write_file`, `edit_file`, `list_files`, `glob`, `grep` | Core file operations |
| Shell & Git | Coding | `bash`, `git` | Shell commands and git operations |
| Docker | DevOps | `docker` | Requires Docker to be installed on the host |
| System Info | DevOps | `system_info` | OS, CPU, memory, disk, network, processes |
| Weather | Home | `weather` | Uses Open-Meteo free API |
| Web Fetch & HTTP | Web | `web_fetch`, `http_request` | Direct URL access, no search engine needed |

### Requires Configuration

| Integration | Category | Tools | Required Env Vars |
|-------------|----------|-------|-------------------|
| Ollama Proxy | Core | *(model inference)* | `VEEPEE_CODE_PROXY_URL` |
| Web Search | Web | `web_search` | `SEARXNG_URL` |
| Home Assistant | Home | `home_assistant`, `timer` | `HA_URL`, `HA_TOKEN` |
| Mastodon | Social | `mastodon` | `MASTODON_URL`, `MASTODON_TOKEN` |
| Spotify | Social | `spotify` | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` |
| Google Workspace | Google | `email`, `calendar`, `google_drive`, `google_docs`, `google_sheets`, `notes` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| Newsfeed | News | `news` | `NEWSFEED_URL` |

## What Each Validation Tests

### Ollama Proxy

Sends `GET /api/tags` to the proxy URL. Checks that the response is HTTP 200 and contains a `models` array. Reports the number of available models.

### Web Search (SearXNG)

Sends a test search query (`q=test`) to the SearXNG JSON API with a DuckDuckGo engine and 1 result limit. Verifies HTTP 200.

### Home Assistant

Sends `GET /api/` to the HA URL with the `Authorization: Bearer <token>` header. Verifies HTTP 200.

### Mastodon

Sends `GET /api/v1/accounts/verify_credentials` with the access token. On success, reports the authenticated account name.

### Spotify

Attempts an OAuth2 token refresh using the client credentials and refresh token. Verifies that Spotify returns a new access token.

### Google Workspace

Attempts an OAuth2 token refresh using the Google client credentials and refresh token. Verifies that Google returns a new access token.

### Newsfeed

Sends `GET /api/ai/briefing` to the newsfeed URL with `Accept: text/plain`. Verifies HTTP 200.

## Troubleshooting

### "Cannot connect to..."

The service is unreachable:
- Verify the URL is correct and the service is running
- Check network connectivity (ping, curl)
- If using a VPN or firewall, ensure the port is accessible
- Check if the service is bound to `127.0.0.1` (localhost only) vs `0.0.0.0` (all interfaces)

### "HTTP 401" or "Auth failed"

Authentication issue:
- Verify the token/credentials are correct and not expired
- For Home Assistant: regenerate the long-lived access token
- For Mastodon: check that the app has the required scopes (`read`, `write`, `follow`)
- For Spotify: refresh tokens can expire if the app is de-authorized
- For Google: refresh tokens expire if the OAuth consent was not set to "production" or if it hasn't been used in 6 months

### "HTTP 403"

Authorization issue:
- The token is valid but lacks required permissions
- Check OAuth scopes for Google and Spotify
- Check Mastodon app permissions

### Tools showing as 0 count

If `/setup` shows active integrations but `/tools` shows fewer tools than expected:
- Optional tools are only registered at startup. Restart VEEPEE Code after changing `.env`.
- Tools are not hot-reloaded -- config changes require a restart.
