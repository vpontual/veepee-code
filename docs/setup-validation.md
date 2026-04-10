---
title: "Setup Validation"
description: "The /setup command, integration status, and troubleshooting."
weight: 10
---

# Setup Validation

The `/setup` command tests connectivity to native integrations and reports their status. Use it to verify your configuration and diagnose connection issues.

> **Note:** Tools that come from the [remote agent bridge](configuration.md#remote-agent-bridge) (Home Assistant, Mastodon, Spotify, Google Workspace, news, weather, timers, etc.) are **not** validated by `/setup` — their connectivity is the remote agent's responsibility. Run `/tools` to see what's actually loaded after the bridge connects.

## Running Setup

```
/setup
```

The command tests each integration in sequence with a 5-second timeout per connection. Results are displayed in three groups: active, needs configuration, and errors.

### Re-running the wizard

```
/setup wizard               # Re-run the full setup wizard
/setup wizard <step-id>     # Re-run a single step (proxy, dashboard, model-prefs, api, searxng, remote)
```

### Automatic First-Run Check

On first launch, `/setup` runs automatically as part of the onboarding flow. It displays a compact summary showing **"X/Y integrations active"** with a hint to run `/setup` manually for full details. This lets new users immediately see which integrations are working without needing to know the command exists.

## Integration Status Report

### Example Output

```
  Integration Status

  ✓ Active (8):
    ● Filesystem [read_file, write_file, edit_file, list_files, glob, grep] — Always available
    ● Shell & Git [bash, git] — Always available
    ● Docker [docker] — Always available (requires Docker installed)
    ● System Info [system_info] — Always available
    ● Web Fetch & HTTP [web_fetch, http_request] — Always available
    ● Ollama Proxy — Connected — 47 models available
    ● Web Search (SearXNG) [web_search] — Connected

  14/15 tools active  |  Config: ~/.veepee-code/vcode.config.json
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
| Shell & Git | Coding | `bash`, `git`, `github` | Shell commands, git, and gh CLI |
| Docker | DevOps | `docker` | Requires Docker to be installed on the host |
| System Info | DevOps | `system_info` | OS, CPU, memory, disk, network, processes |
| Web Fetch & HTTP | Web | `web_fetch`, `http_request` | Direct URL access, no search engine needed |

### Requires Configuration

| Integration | Category | Tools | Required Field |
|-------------|----------|-------|---------------|
| Ollama Proxy | Core | *(model inference)* | `proxyUrl` in `vcode.config.json` |
| Web Search | Web | `web_search` | `searxngUrl` |

### Via Remote Agent Bridge

When `remote: {url, apiKey}` is set in `vcode.config.json`, VEEPEE Code fetches the tool catalog from the remote agent on startup. The set of additional tools depends entirely on what the remote agent exposes (typically Home Assistant, Mastodon, Spotify, Gmail, Calendar, Drive, Docs, Sheets, Tasks, news, weather, timers, and more). These tools are **not** validated by `/setup` — run `/tools` to see what's actually loaded.

## What Each Validation Tests

### Ollama Proxy

Sends `GET /api/tags` to the proxy URL. Checks that the response is HTTP 200 and contains a `models` array. Reports the number of available models.

### Web Search (SearXNG)

Sends a test search query (`q=test`) to the SearXNG JSON API with a DuckDuckGo engine and 1 result limit. Verifies HTTP 200.

## Troubleshooting

### "Cannot connect to..."

The service is unreachable:
- Verify the URL is correct and the service is running
- Check network connectivity (ping, curl)
- If using a VPN or firewall, ensure the port is accessible
- Check if the service is bound to `127.0.0.1` (localhost only) vs `0.0.0.0` (all interfaces)
- VEEPEE Code forces IPv4 first (`dns.setDefaultResultOrder('ipv4first')`) to handle IPv4-only tunnels (WireGuard, VPN). On startup failure, it runs `ping → curl → fetch → IPv4-forced fetch` diagnostics automatically.

### Remote bridge tools missing

If a tool from your remote agent isn't appearing in `/tools`:
- Check the remote agent is running and reachable from VEEPEE Code's machine
- Verify the `remote.apiKey` matches what the remote agent expects
- Re-run `/setup wizard remote` to re-test the connection
- Restart VEEPEE Code — remote tools are discovered once on startup, not hot-reloaded

### Tools showing as 0 count

Tools are registered at startup. Config changes require a `vcode` restart.
