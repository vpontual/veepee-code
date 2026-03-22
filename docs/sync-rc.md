---
title: "Sync & Remote Connect"
description: "Cross-device session sync via WebDAV and phone-accessible web UI."
weight: 17
---

# Sync & Remote Connect

VEEPEE Code v0.3.0 adds two features for cross-device workflows: WebDAV session sync and a phone-accessible web UI.

## Cross-Device Session Sync

### What It Does

Push and pull session files to a WebDAV server (Nextcloud, ownCloud, or any WebDAV-compatible service). Resume a conversation started on your Mac from your Linux laptop, or vice versa.

### Configuration

Add to `~/.veepee-code/.env`:

```bash
VEEPEE_CODE_SYNC_URL=https://cloud.example.com/remote.php/dav/files/user/veepee-code/
VEEPEE_CODE_SYNC_USER=username
VEEPEE_CODE_SYNC_PASS=password
VEEPEE_CODE_SYNC_AUTO=false    # Set to true for auto-sync
```

All three URL/user/pass must be set. Uses Node.js built-in `https`/`http` modules — no additional dependencies.

### Commands

```
/sync push          # Push current session to WebDAV
/sync push all      # Push all sessions
/sync pull          # Pull sessions from WebDAV
/sync auto          # Toggle auto-sync
/sync status        # Show sync configuration
```

### What Syncs

- **Session JSON files** (`{id}-{name}.json`) — full message history, model, mode, metadata
- **Knowledge state files** (`{id}-knowledge.json`) — compressed conversation context

**NOT synced:** Sandbox files (ephemeral by design).

### Conflict Resolution

When pulling, files are compared by `updatedAt` timestamp. The newer version wins:

- If local is newer → skip (don't overwrite)
- If remote is newer → download and overwrite local
- If local doesn't exist → download

### Auto-Sync

When enabled (`/sync auto` or `VEEPEE_CODE_SYNC_AUTO=true`):

- After `/save` → auto-push the saved session
- Before `/sessions` → auto-pull to show the latest list

### WebDAV Implementation

The sync system uses four WebDAV operations, all via Node.js built-in HTTP modules:

| Operation | HTTP Method | Purpose |
|-----------|-------------|---------|
| `webdavPut` | `PUT` | Upload a file |
| `webdavGet` | `GET` | Download a file |
| `webdavPropfind` | `PROPFIND` | List directory contents |
| `webdavMkcol` | `MKCOL` | Create the remote directory (first-time setup) |

Authentication uses HTTP Basic Auth. The remote directory is auto-created on first push.

### Verification

1. Configure WebDAV creds in `~/.veepee-code/.env`
2. `/save test-session` then `/sync push` → files appear on Nextcloud
3. On another machine: `/sync pull` → session appears in `/sessions`
4. `/resume test-session` → knowledge state + recent messages restored

---

## Remote Connect (/rc)

### What It Does

A phone-accessible web chat UI served at `http://{ip}:{port}/rc`. Shared session — phone and TUI see the same conversation, one agent, two views.

### Configuration

Add to `~/.veepee-code/.env`:

```bash
VEEPEE_CODE_RC_ENABLED=1
VEEPEE_CODE_API_TOKEN=your-secret-token    # Required for auth
```

When RC is enabled:
- The API server binds to `0.0.0.0` (all interfaces) instead of `127.0.0.1`
- CORS allows any origin (auth via token protects access)

### Accessing the Web UI

1. Start vcode with RC enabled
2. `/rc` shows the URL (e.g., `http://your-server:8484/rc`)
3. Open the URL on your phone (via Twingate, VPN, or LAN)
4. Enter your API token on the auth screen
5. Start chatting — responses stream in real-time

### Web UI Features

- **Mobile-first responsive design** — works on any screen size
- **Dark theme** — matches the TUI color palette (terracotta brand, sky blue accent)
- **Streaming responses** — SSE-based, shows text as it generates
- **Tool call cards** — shows tool name, arguments, and results
- **Permission cards** — approve/deny/always buttons for tool permissions
- **Session picker** — dropdown to switch between sessions
- **Token auth** — stored in localStorage after first entry

### Permission Handling

When the agent needs permission and RC clients are connected:

1. A `permission_request` SSE event is sent to all connected web clients
2. The web UI shows a permission card with Approve / Always / Deny buttons
3. The user taps a button → `POST /rc/approve` resolves the pending permission
4. If no response within 60 seconds → auto-deny

If no RC clients are connected, the TUI permission prompt is used as fallback.

### Networking

VEEPEE Code is designed to work with **Twingate** (or any VPN) for remote access:

- When RC is enabled, the server binds to `0.0.0.0`
- Access via your machine's LAN IP through Twingate
- No Cloudflare Tunnel or port forwarding needed
- Example: `http://your-server:8484/rc` from your phone on Twingate

### API Endpoints

See the [API Reference](api.md#remote-connect-endpoints) for the full list of RC endpoints.

### Verification

1. Set `VEEPEE_CODE_RC_ENABLED=1` and `VEEPEE_CODE_API_TOKEN=secret`
2. Start vcode → `/rc` shows URL
3. Open URL on phone → enter token → chat interface loads
4. Send message → streaming response with tool calls
5. Tool call → approve/deny buttons appear → tap approve → execution continues

---

## Feature Composition

The four v0.3.0 features compose together:

| Combo | How They Work Together |
|-------|----------------------|
| **Sandbox + Preview** | Write scratch code → preview it → `/sandbox keep` if good |
| **Sandbox + RC** | Web UI can preview sandbox files |
| **Sync + RC** | Pull sessions from phone, resume on any device |
| **Sync + Sandbox** | Sandbox is NOT synced (ephemeral). Only sessions + knowledge state sync. |
| **Preview + RC** | `/rc/preview` endpoint uses PreviewManager |
| **All four** | Mac: write in sandbox → preview → save → sync push. Phone: sync pull → resume → preview |
