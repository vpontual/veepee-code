---
title: "API Reference"
description: "OpenAI-compatible API on port 8484: endpoints, streaming, and multi-agent collaboration."
weight: 9
---

# API Reference

VEEPEE Code runs an HTTP API server alongside the TUI, enabling other tools and scripts to use it as a backend. The API is OpenAI-compatible for chat completions and models, with custom extensions for tool execution and status.

## Server Details

- **Default port:** 8484 (configurable via `VEEPEE_CODE_API_PORT` or `--port` CLI flag)
- **Bind address:** `127.0.0.1` (localhost only by default; override with `--host` CLI flag)
- **Auto-fallback:** If the port is in use, VEEPEE Code automatically tries port + 1
- **CORS:** Restricted to localhost origins by default. When Remote Connect is enabled (`VEEPEE_CODE_RC_ENABLED=1`), CORS allows any origin (auth via token protects access).

The API starts automatically when VEEPEE Code launches. No separate process needed.

### Authentication

If the `VEEPEE_CODE_API_TOKEN` environment variable is set, all API requests must include a Bearer token in the `Authorization` header:

```
Authorization: Bearer your-token-here
```

Requests without a valid token receive a `401 Unauthorized` response. If the variable is not set, authentication is disabled (open access on localhost).

## Endpoints

### POST /v1/chat/completions

OpenAI-compatible chat completions. The agent processes the last user message, executes tools as needed, and returns the result.

**Request:**

```json
{
  "model": "qwen3.5:35b",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Read src/index.ts and summarize it." }
  ],
  "stream": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | No | Model to use. If specified and valid, the agent switches to it. Otherwise uses the current default. |
| `messages` | array | Yes | Array of message objects with `role` and `content`. Only the last user message is processed. |
| `stream` | boolean | No | Enable Server-Sent Events streaming (default false). |
| `tools` | array | No | OpenAI-format tool definitions. If provided, constrains the agent to only use tools in this list (intersection with registered tools). Constraints are enforced at the registry level: only matching tools are sent to Ollama and execution is gated, not just prompt-based. |

**Non-streaming response:**

```json
{
  "id": "chatcmpl-1710763200000",
  "object": "chat.completion",
  "created": 1710763200,
  "model": "qwen3.5:35b",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The file is the main entry point...",
        "tool_calls": [
          {
            "id": "call_0",
            "type": "function",
            "function": {
              "name": "read_file",
              "arguments": "{\"path\":\"src/index.ts\"}"
            }
          }
        ]
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

> **Note:** The `usage` field always returns zeros -- token counting is approximate and tracked separately in the context manager. The assistant message includes a standard OpenAI `tool_calls` array when tool calls were made.

**Streaming response (SSE):**

When `stream: true`, the server sends Server-Sent Events:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"qwen3.5:35b","choices":[{"index":0,"delta":{"content":"The "},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"qwen3.5:35b","choices":[{"index":0,"delta":{"content":"file "},"finish_reason":null}]}
```

Tool calls are streamed as standard OpenAI `tool_calls` deltas, alongside legacy `veepee_code` extensions for backwards compatibility:

```
data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_0","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"src/index.ts\"}"}}]},"finish_reason":null}],"veepee_code":{"tool_call":{"name":"read_file","args":{"path":"src/index.ts"}}}}

data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}],"veepee_code":{"tool_result":{"name":"read_file","success":true,"output":"..."}}}
```

The stream ends with:

```
data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### GET /v1/models

List all available models in OpenAI-compatible format, with VEEPEE Code extensions.

**Response:**

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen3.5:35b",
      "object": "model",
      "created": 1710763200,
      "owned_by": "ollama",
      "capabilities": ["tools", "code", "thinking"],
      "tier": "heavy",
      "parameter_size": "35B",
      "score": 142,
      "is_loaded": true
    },
    {
      "id": "qwen3:8b",
      "object": "model",
      "created": 1710763200,
      "owned_by": "ollama",
      "capabilities": ["tools", "code"],
      "tier": "standard",
      "parameter_size": "8B",
      "score": 82,
      "is_loaded": false
    }
  ]
}
```

Custom fields per model: `capabilities`, `tier`, `parameter_size`, `score`, `is_loaded`.

### GET /api/tools

List all registered tools.

**Response:**

```json
{
  "tools": [
    { "name": "read_file", "description": "Read a file from the filesystem..." },
    { "name": "write_file", "description": "Write content to a file..." },
    { "name": "bash", "description": "Execute a shell command..." }
  ],
  "count": 25
}
```

### POST /api/execute

Execute a specific tool directly, bypassing the LLM.

**This endpoint is disabled by default.** To enable it, set `VEEPEE_CODE_API_EXECUTE=1` in your environment or `.env` file. Requests to this endpoint when it is disabled receive a `403 Forbidden` response.

**Request:**

```json
{
  "tool": "glob",
  "args": {
    "pattern": "**/*.ts"
  }
}
```

**Response:**

```json
{
  "success": true,
  "output": "Found 47 files:\nsrc/index.ts\nsrc/agent.ts\n..."
}
```

Or on error:

```json
{
  "success": false,
  "output": "",
  "error": "Unknown tool: nonexistent"
}
```

> **Note:** Tool execution through the API bypasses the permission system entirely. This endpoint is gated behind `VEEPEE_CODE_API_EXECUTE=1` as a safety measure.

### GET /api/status

Get the current session status.

**Response:**

```json
{
  "model": "qwen3.5:35b",
  "tools": 25,
  "messages": 12,
  "tokens_estimate": 4500,
  "cwd": "/Users/vp/project"
}
```

### GET / or GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "service": "veepee-code"
}
```

## CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--host` | Bind address for the API server | `127.0.0.1` |
| `--port` | Port for the API server | `8484` |

Example:

```bash
vcode --host 0.0.0.0 --port 9000
```

## Connect Snippets

### Claude Code

Add VEEPEE Code as an MCP-compatible backend in Claude Code's settings. With auth enabled:

```bash
curl -X POST http://127.0.0.1:8484/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $VEEPEE_CODE_API_TOKEN" \
  -d '{
    "messages": [{"role": "user", "content": "Run the test suite and fix any failures"}],
    "stream": true
  }'
```

Claude Code handles the high-level planning while VEEPEE Code executes tool calls locally with zero API cost.

### OpenCode

Point OpenCode at the VEEPEE Code API in `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "veepee": {
      "api_key": "your-token-here",
      "api_url": "http://127.0.0.1:8484/v1"
    }
  }
}
```

OpenCode will use the `/v1/chat/completions` and `/v1/models` endpoints with standard OpenAI `tool_calls` format.

## Multi-Agent Collaboration

The API enables a powerful workflow where multiple AI tools collaborate:

### Gemini CLI Integration

Gemini CLI can use VEEPEE Code's models endpoint for model discovery and the chat endpoint for local inference:

```bash
# List available local models
curl http://127.0.0.1:8484/v1/models

# Use a local model through Gemini CLI's custom backend support
curl -X POST http://127.0.0.1:8484/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3.5:35b", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Custom Scripts

Build automation scripts that leverage VEEPEE Code's tools:

```python
import requests

# Execute a tool directly
result = requests.post("http://127.0.0.1:8484/api/execute", json={
    "tool": "grep",
    "args": {"pattern": "TODO", "include": "*.ts"}
})
print(result.json()["output"])

# Ask the agent to analyze and act
result = requests.post("http://127.0.0.1:8484/v1/chat/completions", json={
    "messages": [{"role": "user", "content": "Find and fix all TODO items in the codebase"}]
})
print(result.json()["choices"][0]["message"]["content"])
```

## Remote Connect Endpoints

When `VEEPEE_CODE_RC_ENABLED=1`, the following endpoints are available. All `/rc/*` routes (except `GET /rc`) require Bearer token auth.

### GET /rc

Serve the Remote Connect web UI. Returns an HTML page with inline CSS and JavaScript — no build step required.

### GET /rc/stream?token=\<token\>

SSE event stream mirroring agent events to web clients. Event types:

| Event | Data |
|-------|------|
| `text` | `{ content: string }` |
| `tool_call` | `{ name: string, args: object }` |
| `tool_result` | `{ name: string, success: boolean, output: string }` |
| `done` | `{ evalCount: number, tokensPerSecond: number }` |
| `error_event` | `{ error: string }` |
| `permission_request` | `{ callId: string, toolName: string, args: object, reason?: string }` |

Includes 15-second keepalive pings.

### POST /rc/send

Send a user message to the agent. The response streams via SSE to all connected clients.

```json
{ "message": "Fix the bug in auth.ts" }
```

### GET /rc/sessions

List sessions (up to 20, newest first).

### POST /rc/resume

Resume a session by ID.

```json
{ "sessionId": "abc123" }
```

### POST /rc/approve

Approve or deny a pending tool permission request.

```json
{ "callId": "hex-string", "decision": "y" }
```

Decisions: `y` (allow once), `a` (always allow), `n` (deny). Unanswered requests auto-deny after 60 seconds.

### POST /rc/preview

Preview a file (returns URL or script output).

```json
{ "file": "/path/to/file.html" }
```

## Error Handling

All endpoints return JSON error responses:

```json
{
  "error": "Description of what went wrong"
}
```

HTTP status codes:

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 204 | No content (OPTIONS preflight) |
| 400 | Bad request (missing fields, invalid JSON) |
| 401 | Unauthorized (missing or invalid Bearer token) |
| 403 | Forbidden (`/api/execute` disabled) |
| 404 | Endpoint not found |
| 500 | Internal server error |
