---
title: "Tools Reference"
description: "All 25 tools organized by category with descriptions, parameters, and usage examples."
weight: 5
---

# Tools Reference

VEEPEE Code includes 25 tools organized into seven categories. Core tools are always available. Optional tools activate when their required environment variables are configured.

Run `/tools` to see which tools are active in your current session, or `/setup` to see the full integration status.

## Coding Tools (Always Available)

### read_file

Read a file from the filesystem with line numbers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Absolute or relative file path |
| `offset` | number | No | Start reading from this line number (1-based) |
| `limit` | number | No | Maximum number of lines to return |

```
read_file path="src/index.ts"
read_file path="src/large-file.ts" offset=100 limit=50
```

> **Note:** The agent always reads a file before editing it. This is enforced by the system prompt.

### write_file

Write content to a file, creating it if it does not exist or overwriting if it does.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path to write to |
| `content` | string | Yes | Full file content |

```
write_file path="src/utils/helper.ts" content="export function add(a: number, b: number) { return a + b; }"
```

### edit_file

Edit a file by replacing an exact string match. The old_string must be unique in the file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path to edit |
| `old_string` | string | Yes | Exact string to find (must be unique) |
| `new_string` | string | Yes | Replacement string |

```
edit_file path="src/api.ts" old_string="const port = 3000;" new_string="const port = 8080;"
```

> **Note:** If old_string is not found, the tool returns an error advising to read the file first. If old_string matches multiple locations, the tool requires more surrounding context to make it unique.

### glob

Find files matching a glob pattern. Automatically ignores `node_modules`, `.git`, `dist`, `build`, and `.next`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Glob pattern (e.g., `**/*.ts`, `src/**/*.js`) |
| `cwd` | string | No | Base directory (defaults to working directory) |

```
glob pattern="**/*.test.ts"
glob pattern="src/**/*.tsx" cwd="/path/to/project"
```

Results are capped at 100 entries.

### grep

Search file contents using regex. Uses ripgrep (`rg`) if available, falls back to `grep`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Regex pattern to search for |
| `path` | string | No | File or directory to search (defaults to `.`) |
| `include` | string | No | File pattern filter (e.g., `*.ts`) |
| `max_results` | number | No | Maximum results (default 50) |

```
grep pattern="interface User" include="*.ts"
grep pattern="TODO|FIXME|HACK" path="src/"
```

### bash

Execute a shell command with full output capture. Runs in a spawned bash process with a configurable timeout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `cwd` | string | No | Working directory |
| `timeout` | number | No | Timeout in milliseconds (default 120,000) |

```
bash command="npm test"
bash command="docker compose up -d" cwd="/home/user/project"
bash command="curl -s https://api.example.com/health" timeout=5000
```

> **Note:** Destructive patterns (`rm -rf`, `git push --force`, `git reset --hard`) trigger the permission system and require explicit approval.

### git

Run git commands in the current or specified repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `args` | string | Yes | Git arguments |
| `cwd` | string | No | Repository directory |

```
git args="status"
git args="diff --staged"
git args="log --oneline -10"
git args="add src/api.ts"
git args="commit -m 'Fix auth bug'"
```

### list_files

List files and directories in a given path.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No | Directory to list (defaults to `.`) |
| `recursive` | boolean | No | List recursively (default false, max 2 levels) |

```
list_files
list_files path="src/tools" recursive=true
```

## Web Tools

### web_fetch (Always Available)

Fetch a web page and extract readable text. Strips HTML tags, scripts, styles, nav, header, and footer elements.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `max_length` | number | No | Max characters to return (default 10,000) |

```
web_fetch url="https://react.dev/blog/2025/04/25/react-19"
web_fetch url="https://api.github.com/repos/vpontual/veepee-code" max_length=5000
```

JSON responses are automatically pretty-printed.

### http_request (Always Available)

Make HTTP requests with full control over method, headers, and body.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to request |
| `method` | string | No | HTTP method: GET, POST, PUT, PATCH, DELETE, HEAD (default GET) |
| `headers` | string | No | Headers as JSON string |
| `body` | string | No | Request body |

```
http_request url="https://api.example.com/data" method="POST" headers='{"Authorization":"Bearer xxx"}' body='{"key":"value"}'
```

### web_search (Requires SEARXNG_URL)

Search the web via SearXNG metasearch. Returns titles, URLs, and snippets from Google, DuckDuckGo, and Brave.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `max_results` | number | No | Maximum results (default 5) |

```
web_search query="TypeScript 5.5 new features"
web_search query="Next.js 16 migration guide" max_results=10
```

## DevOps Tools (Always Available)

### docker

Run Docker commands for container management.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `args` | string | Yes | Docker arguments |
| `cwd` | string | No | Working directory for compose commands |

```
docker args="ps -a"
docker args="logs mycontainer --tail 50"
docker args="compose up -d" cwd="/home/user/project"
docker args="images"
docker args="compose logs --follow"
```

### system_info

Get system information across six categories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | One of: `overview`, `memory`, `disk`, `cpu`, `network`, `processes` |

```
system_info query="memory"
system_info query="disk"
system_info query="processes"
```

Cross-platform: macOS uses `sysctl`, `vm_stat`, `sw_vers`; Linux uses `free`, `lscpu`, `/etc/os-release`.

## Home Tools

### weather (Always Available)

Get current weather or forecast using Open-Meteo (free, no API key).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `current` or `forecast` |
| `location` | string | Yes | City name or coordinates |
| `days` | number | No | Forecast days (default 3, max 7) |

```
weather action="current" location="San Francisco"
weather action="forecast" location="New York" days=7
weather action="current" location="37.7749,-122.4194"
```

Temperature is returned in Fahrenheit, wind in mph.

### home_assistant (Requires HA_URL, HA_TOKEN)

Control smart home devices via Home Assistant.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `get_states`, `get_state`, `turn_on`, `turn_off`, `toggle`, or `call_service` |
| `entity_id` | string | No | Entity ID (e.g., `light.living_room`) |
| `domain` | string | No | Service domain for call_service |
| `service` | string | No | Service name for call_service |
| `data` | string | No | Service data as JSON string |

```
home_assistant action="get_states"
home_assistant action="toggle" entity_id="light.office"
home_assistant action="call_service" domain="climate" service="set_temperature" data='{"temperature":72}'
```

> **Note:** Device control actions (`turn_on`, `turn_off`, `toggle`, `call_service`) always trigger the permission prompt.

### timer (Requires HA_URL, HA_TOKEN)

Set timers with optional TTS announcement via Home Assistant.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `set`, `list`, or `cancel` |
| `name` | string | No | Timer label |
| `seconds` | number | No | Duration in seconds |
| `message` | string | No | TTS message on completion |

```
timer action="set" name="Pomodoro" seconds=1500 message="Break time!"
timer action="set" seconds=300
```

## Social Tools

### mastodon (Requires MASTODON_URL, MASTODON_TOKEN)

Interact with the Fediverse via Mastodon.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `timeline`, `notifications`, `post`, `reply`, `boost`, `favorite`, or `search` |
| `content` | string | No | Post/reply text |
| `status_id` | string | No | Status ID for reply/boost/favorite |
| `query` | string | No | Search query |
| `limit` | number | No | Results limit (default 10) |

```
mastodon action="timeline"
mastodon action="post" content="Hello from VEEPEE Code!"
mastodon action="reply" content="Great point!" status_id="123456"
mastodon action="search" query="rust programming"
```

> **Note:** Public actions (`post`, `reply`, `boost`) trigger the permission prompt.

### spotify (Requires SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN)

Control Spotify playback and search.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `playing`, `play`, `pause`, `next`, `previous`, `volume`, `search`, `queue`, or `recent` |
| `query` | string | No | Search query |
| `uri` | string | No | Spotify URI for play/queue |
| `volume` | number | No | Volume 0-100 |

```
spotify action="playing"
spotify action="search" query="lo-fi beats"
spotify action="play" uri="spotify:track:..."
spotify action="volume" volume=50
spotify action="next"
```

> **Note:** Playback control actions (`play`, `pause`, `next`, `previous`, `volume`) trigger the permission prompt.

## Google Workspace Tools (Require GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)

### email

Read and send Gmail emails.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `inbox`, `read`, `send`, or `search` |
| `message_id` | string | No | Message ID to read |
| `to` | string | No | Recipient email |
| `subject` | string | No | Email subject |
| `body` | string | No | Email body |
| `query` | string | No | Gmail search syntax query |
| `max_results` | number | No | Max results (default 10) |

```
email action="inbox"
email action="read" message_id="18e4a7b2c..."
email action="send" to="user@example.com" subject="Meeting notes" body="..."
email action="search" query="from:boss subject:urgent"
```

> **Note:** Sending email always triggers the permission prompt.

### calendar

Manage Google Calendar events.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `today`, `upcoming`, or `create` |
| `summary` | string | No | Event title |
| `start` | string | No | Start time (ISO 8601) |
| `end` | string | No | End time (ISO 8601) |
| `description` | string | No | Event description |
| `max_results` | number | No | Max events (default 10) |

```
calendar action="today"
calendar action="upcoming" max_results=5
calendar action="create" summary="Standup" start="2026-03-20T09:00:00-07:00" end="2026-03-20T09:30:00-07:00"
```

### google_drive

Search and read Google Drive files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `list`, `search`, or `read` |
| `query` | string | No | Search query or file ID |
| `max_results` | number | No | Max results (default 10) |

```
google_drive action="list"
google_drive action="search" query="project proposal"
google_drive action="read" query="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
```

### google_docs

Read and create Google Docs documents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `read` or `create` |
| `document_id` | string | No | Document ID to read |
| `title` | string | No | Title for new document |
| `content` | string | No | Content for new document |

```
google_docs action="read" document_id="1BxiMVs..."
google_docs action="create" title="Meeting Notes" content="# Summary\n..."
```

### google_sheets

Read and write Google Sheets.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `read`, `write`, or `create` |
| `spreadsheet_id` | string | No | Spreadsheet ID |
| `range` | string | No | Cell range (e.g., `Sheet1!A1:D10`) |
| `values` | string | No | Values as JSON 2D array |
| `title` | string | No | Title for new spreadsheet |

```
google_sheets action="read" spreadsheet_id="1abc..." range="Sheet1!A1:D10"
google_sheets action="write" spreadsheet_id="1abc..." range="Sheet1!A1" values='[["Name","Score"],["Alice",95]]'
google_sheets action="create" title="Q1 Budget"
```

### notes

Manage Google Tasks (used as a notes/todo system).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `list`, `create`, or `complete` |
| `title` | string | No | Task title |
| `notes` | string | No | Task notes/description |
| `task_id` | string | No | Task ID to complete |
| `tasklist_id` | string | No | Task list ID (default: primary) |

```
notes action="list"
notes action="create" title="Review PR #42" notes="Check the migration logic"
notes action="complete" task_id="MTA2..."
```

## News Tools (Require NEWSFEED_URL)

### news

Access the AI-optimized newsfeed with multiple modes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `briefing`, `digest`, `search`, `trends`, `topic`, or `story` |
| `query` | string | No | Search query or topic name |
| `story_id` | string | No | Story ID for story tracking |
| `hours` | number | No | Time window in hours |

```
news action="briefing"
news action="digest" hours=24
news action="search" query="artificial intelligence"
news action="trends" hours=48
news action="topic" query="climate change"
news action="story" story_id="abc123"
```

## Tool Count by Category

| Category | Always Available | Conditional | Total |
|----------|-----------------|-------------|-------|
| Coding | 8 | 0 | 8 |
| Web | 2 | 1 | 3 |
| DevOps | 2 | 0 | 2 |
| Home | 1 | 2 | 3 |
| Social | 0 | 2 | 2 |
| Google | 0 | 6 | 6 |
| News | 0 | 1 | 1 |
| **Total** | **13** | **12** | **25** |
