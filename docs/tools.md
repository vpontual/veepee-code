---
title: "Tools Reference"
description: "Native tools (14, plus web_search when SearXNG is configured) organized by category with descriptions, parameters, and usage examples. Additional tools come from the remote agent bridge."
weight: 5
---

# Tools Reference

VEEPEE Code ships with **14 native tools** in three categories: coding (10), web (2), and devops (2). One additional web tool (`web_search`) activates when SearXNG is configured.

**Additional tools** — Home Assistant, Mastodon, Spotify, Gmail, Calendar, Drive, Docs, Sheets, Tasks, news feeds, weather, timers, and any other capability — come from the **remote agent bridge** (see [Configuration](configuration.md#remote-agent-bridge)). When a remote agent is configured, VEEPEE Code fetches its tool catalog on startup and proxies execution via HTTP, surfacing each remote tool as if it were native.

Run `/tools` to see which tools are active in your current session, or `/setup` to see the full integration status.

> **Note:** Directories registered via `/add-dir` are searched by `@file` mentions and tool operations (read_file, glob, grep, etc.), extending the agent's working scope beyond the primary CWD.

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

Search file contents using regex. Uses ripgrep (`rg`) if available, falls back to `grep`. Executes via `execFileSync` (no shell injection).

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

Run git commands in the current or specified repository. Executes via `execFileSync` (no shell injection).

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

### github

Interact with GitHub via the `gh` CLI. Manage repos, pull requests, issues, and releases. Executes via `execFileSync` (no shell injection). Requires `gh` to be installed and authenticated.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | One of: `repo_create`, `repo_list`, `pr_create`, `pr_list`, `pr_view`, `pr_merge`, `pr_comment`, `pr_diff`, `pr_checks`, `issue_create`, `issue_list`, `issue_view`, `issue_comment`, `release_create`, `release_list` |
| `repo` | string | No | Repository in `owner/name` format. Omit to use the repo in cwd. |
| `title` | string | No | Title for PR, issue, release, or new repo name |
| `body` | string | No | Body/description for PR, issue, release, or comment text |
| `branch` | string | No | Branch name for PR (head) or release tag |
| `base` | string | No | Base branch for PR |
| `number` | number | No | PR or issue number (for view/merge/comment actions) |
| `labels` | string | No | Comma-separated labels |
| `draft` | boolean | No | Create PR as draft |
| `is_private` | boolean | No | Create repo as private (default true) |
| `limit` | number | No | Max results for list actions (default 20) |
| `cwd` | string | No | Git repository directory |

```
github action="pr_list"
github action="pr_view" number=42
github action="pr_create" title="Fix auth bug" body="Resolves #41" branch="auth-fix" base="main"
github action="issue_create" title="Investigate slow query" labels="bug,performance"
github action="release_create" branch="v0.4.0" title="v0.4.0" body="Release notes here..."
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

## Tools Available via the Remote Agent Bridge

The following tool categories are **not** built into VEEPEE Code. They live in a separate remote agent (such as [Llama Rider](https://github.com/vpontual/llama_rider)) and are exposed to VEEPEE Code via the bridge described in the [Configuration](configuration.md#remote-agent-bridge) docs.

When you point `vcode.config.json` at a remote agent, VEEPEE Code fetches its tool catalog from `${remote.url}/dashboard/api/tools` on startup, builds Zod schemas from the JSON Schema parameters, and registers each remote tool as if it were native (with a `[remote]` prefix in the description). Execution is proxied via HTTP. Tools that already exist locally take priority — the local version always wins.

Typical tools you'd surface this way:

- **Smart home** — `weather`, `home_assistant` (turn devices on/off, call services), `timer`
- **Social** — `mastodon` (timeline, post, reply, boost, favorite, search), `spotify` (playback, queue, search)
- **Google Workspace** — `email` (Gmail), `calendar`, `google_drive`, `google_docs`, `google_sheets`, `notes` (Google Tasks)
- **News** — `news` (briefing, digest, search, trends, topics, story tracking)

Each of these uses its own auth (HA token, OAuth2, Bearer tokens, etc.) configured in the **remote agent**, not in VEEPEE Code. VEEPEE Code only needs the remote agent's URL and Bearer token.

Refer to your remote agent's documentation for the exact list of tools and parameters it provides.


## Knowledge Tools (Always Available)

### update_memory

Store facts, decisions, context, and preferences in the agent's knowledge state. This tool persists information across sessions, allowing the agent to remember project-specific context, user preferences, and prior decisions. Registered alongside the coding tools in `src/tools/coding.ts`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Category: `fact`, `decision`, `question`, `project`, `current_task`, or any custom key |
| `value` | string | Yes | The information to remember |

```
update_memory key="fact" value="This project uses pnpm, not npm"
update_memory key="decision" value="Using SQLite instead of PostgreSQL for this project"
update_memory key="open_question" value="Should tokens expire after 24h or 7d?"
```

> **Note:** Stored knowledge is saved to `~/.veepee-code/sessions/{sessionId}-state.md` and loaded automatically when you `/resume` the session. The agent intercepts `update_memory` calls before the registry — they update the in-memory `KnowledgeState` directly rather than going through tool execution.

## Native Tool Count by Category

| Category | Always Available | Conditional | Total |
|----------|-----------------|-------------|-------|
| Coding (incl. `update_memory`, `github`) | 10 | 0 | 10 |
| Web | 2 | 1 (`web_search` if SearXNG configured) | 3 |
| DevOps | 2 | 0 | 2 |
| **Native total** | **14** | **1** | **15** |

For additional capabilities (smart home, social, Google Workspace, news, etc.), configure a [remote agent bridge](configuration.md#remote-agent-bridge) — the number of available tools then depends entirely on what the remote agent exposes.
