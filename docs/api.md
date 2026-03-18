---
title: "API Reference"
description: "OpenAI-compatible API on port 8484: endpoints, streaming, and multi-agent collaboration."
weight: 9
---

# API Reference

VEEPEE Code runs an HTTP API server alongside the TUI, enabling other tools and scripts to use it as a backend. The API is OpenAI-compatible for chat completions and models, with custom extensions for tool execution and status.

## Server Details

- **Default port:** 8484 (configurable via `VEEPEE_CODE_API_PORT`)
- **Bind address:** `0.0.0.0` (accessible from other machines on your network)
- **Auto-fallback:** If the port is in use, VEEPEE Code automatically tries port + 1
- **CORS:** Enabled for all origins (`Access-Control-Allow-Origin: *`)

The API starts automatically when VEEPEE Code launches. No separate process needed.

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
        "content": "The file is the main entry point..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  },
  "veepee_code": {
    "tool_calls": [
      {
        "name": "read_file",
        "args": { "path": "src/index.ts" },
        "result": "..."
      }
    ]
  }
}
```

> **Note:** The `usage` field always returns zeros -- token counting is approximate and tracked separately in the context manager. The `veepee_code` extension contains the list of tool calls that were executed during processing.

**Streaming response (SSE):**

When `stream: true`, the server sends Server-Sent Events:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"qwen3.5:35b","choices":[{"index":0,"delta":{"content":"The "},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"qwen3.5:35b","choices":[{"index":0,"delta":{"content":"file "},"finish_reason":null}]}
```

Tool calls and results are also streamed as events with `veepee_code` extensions:

```
data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}],"veepee_code":{"tool_call":{"name":"read_file","args":{"path":"src/index.ts"}}}}

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

> **Note:** Tool execution through the API bypasses the permission system entirely. This endpoint is intended for trusted programmatic use.

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

## Multi-Agent Collaboration

The API enables a powerful workflow where multiple AI tools collaborate:

### Claude Code as Orchestrator

Claude Code can use VEEPEE Code as a local execution backend:

```bash
# In Claude Code's configuration, point to VEEPEE Code's API
curl -X POST http://localhost:8484/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Run the test suite and fix any failures"}],
    "stream": true
  }'
```

Claude Code handles the high-level planning while VEEPEE Code executes tool calls locally with zero API cost.

### Gemini CLI Integration

Gemini CLI can use VEEPEE Code's models endpoint for model discovery and the chat endpoint for local inference:

```bash
# List available local models
curl http://localhost:8484/v1/models

# Use a local model through Gemini CLI's custom backend support
curl -X POST http://localhost:8484/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3.5:35b", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Custom Scripts

Build automation scripts that leverage VEEPEE Code's tools:

```python
import requests

# Execute a tool directly
result = requests.post("http://localhost:8484/api/execute", json={
    "tool": "grep",
    "args": {"pattern": "TODO", "include": "*.ts"}
})
print(result.json()["output"])

# Ask the agent to analyze and act
result = requests.post("http://localhost:8484/v1/chat/completions", json={
    "messages": [{"role": "user", "content": "Find and fix all TODO items in the codebase"}]
})
print(result.json()["choices"][0]["message"]["content"])
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
| 404 | Endpoint not found |
| 500 | Internal server error |
