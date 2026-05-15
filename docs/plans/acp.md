# vcode ACP — Agent Client Protocol

vcode runs as a first-class Zed ACP agent, replacing Claude Code (claude-acp)
entirely. Transport: newline-delimited JSON-RPC 2.0 over stdio. Zed spawns
`vcode acp` as a subprocess.

---

## Status: all phases shipped and live-verified in Zed (2026-05-15)

| Phase | What | Status |
|---|---|---|
| 0 | Transport, lifecycle, initialize/authenticate/session/new/session/close | ✅ Live |
| 1 | session/prompt streaming, session/cancel | ✅ Live |
| 2 | session/list, session/load, session/resume, auto-save | ✅ Live |
| 3 | session/request_permission → Zed native dialog | ✅ Live |
| 4 | session/set_config_option, configOptions, modes pickers | ✅ Live |
| 5 | MCP forwarding (stdio + SSE + HTTP) | ✅ Live |

Live-verified in Zed:
- Tool call rendering (`tool_call` / `tool_call_update` display correctly)
- Permission dialog (native allow/deny fires; "Always allow" persists to disk)
- Session persistence: Threads Sidebar (`ctrl-alt-j`) loads history correctly
- Reasoning rendering: Thinking block shows model reasoning only, no leakage

---

## Dev workflow

Zed `~/.config/zed/settings.json` points directly at the dev build:
```json
"vcode-acp": {
  "command": "/home/vp/Dev/veepee-code/dist/index.js",
  "args": ["acp"]
}
```

`npm run build` → restart Zed → changes are live. No copy step.

`npm run install:local` — build + copy to `~/.veepee-code/dist/` for CLI use.
`npm run smoke:acp` — smoke test against dev build.
`npm run smoke:acp:installed` — smoke test against installed binary.

Zed logs at `~/.local/share/zed/logs/Zed.log` — useful for ACP protocol errors.

---

## Key files

| File | Purpose | Lines |
|---|---|---|
| `src/acp.ts` | Transport + all method handlers | ~750 |
| `src/acp-session.ts` | AcpSession class, MCP conversion, auto-save | ~180 |
| `src/index.ts` | `vcode acp` subcommand dispatch | +8 lines |
| `scripts/acp-smoke.sh` | Smoke test runner | — |
| `scripts/acp-assert.mjs` | Smoke test assertions | — |

---

## ACP methods implemented

| Method | Handler | Notes |
|---|---|---|
| `initialize` | `handleInitialize` | Returns capabilities, negotiates protocol version |
| `authenticate` | inline | Returns `{}` (no-op, local agent) |
| `session/new` | `handleSessionNew` | Creates session, connects MCP, returns configOptions + modes |
| `session/close` | `handleSessionClose` | Aborts agent, closes MCP clients |
| `session/list` | `handleSessionList` | Returns ACP-shaped list from `~/.veepee-code/sessions/` |
| `session/load` | `handleSessionLoadOrResume` | Restores history, replays via session/update notifications |
| `session/resume` | `handleSessionLoadOrResume` | Silent restore (no replay) |
| `session/prompt` | `handleSessionPrompt` | Streams all AgentEvents; stays open for full turn |
| `session/cancel` | `handleSessionCancel` | Sets cancelled flag, calls agent.abort() |
| `session/request_permission` | (outbound) | Agent → Zed; awaits Zed native dialog |
| `session/set_config_option` | `handleSessionSetConfigOption` | mode / model / effort |
| `session/set_mode` | `handleSessionSetMode` | Compat shim → delegates to set_config_option |

---

## AgentEvent → ACP mapping

vcode's `agent.run()` yields `AgentEvent`s. Current mapping in `handleSessionPrompt`:

| AgentEvent type | ACP action |
|---|---|
| `text` | `agent_message_chunk` (buffered pre-thinking; see reasoning section) |
| `thinking` | `agent_thought_chunk` (model reasoning only) |
| `info` | **silently dropped** in ACP (internal vcode status, not model reasoning) |
| `tool_call` | `tool_call` notification (`status: "pending"`) |
| `tool_result` | `tool_call_update` notification (`status: "completed"` or `"failed"`) |
| `permission_denied` | `tool_call_update` with `status: "failed"` |
| `model_switch` | `config_option_update` session/update notification |
| `reset_stream` | clears textBuffer (no ACP equivalent) |
| `hook_output` | `agent_thought_chunk` |
| `error` | logged to stderr only |
| `done` | no notification; `session/prompt` responds with `{ stopReason: "end_turn" }` |

### `info` vs `thinking` event types

`thinking` is reserved for actual model reasoning content (from `<think>` blocks).
`info` is used for all vcode-internal status messages:

- `Plan auto-saved to .veepee/plan.md`
- `Restored plan from .veepee/plan.md`
- `Compacted conversation to free context space`
- `Compacting harder (attempt N)...`
- `Steering: ...`
- `No vision model available — image will be described by path only`

In the TUI, `info` renders identically to `thinking` (via `tui.showThinking()`).
In ACP, `info` events have an explicit `case 'info': break;` — they are dropped.

---

## Reasoning rendering (Qwen3 / vLLM)

Qwen3.6 without `--reasoning-parser` emits thinking as plain `text` events,
then fires `reset_stream` + `thinking` at the `</think>` boundary. ACP has no
retraction mechanism, so any text sent before `</think>` is detected would
appear as visible message content.

**Fix:** buffer all `text` events until `seenThinking` is confirmed.

```
text event arrived:
  if seenThinking → send immediately as agent_message_chunk
  else → append to textBuffer

thinking event arrived:
  flushTextBuffer() → discard buffered text (it was reasoning)
  set seenThinking = true
  send agent_thought_chunk

reset_stream event:
  textBuffer = ''   ← orphan reasoning text discarded

tool_result event:
  textBuffer = ''
  seenThinking = false   ← RESET: next LLM call starts fresh
  (multi-call turns: each call can have its own orphan reasoning)

finally block:
  flushTextBuffer()   ← non-thinking models: flush all buffered text here
```

The reset on `tool_result` is critical. Without it, `seenThinking = true` from
the first LLM call persists into the second, and the second call's orphan
reasoning leaks as visible text.

---

## Tool call ID tracking (FIFO queues)

vcode `AgentEvent` has no stable tool call ID — tool calls and results are
identified by tool name only. Multiple calls to the same tool in one turn
(e.g. two `read_file` calls) would collide on a name-keyed Map.

**Solution:** `pendingByName: Map<string, string[]>` — FIFO queue per tool name.

- `mintId(name)` — on `tool_call` event: pushes a new `call_N` id, returns it
- `resolveId(name)` — on `tool_result` / `permission_denied`: shifts from front
- `peekId(name)` — non-destructive read; used by permission handler (which runs
  between `tool_call` and `tool_result`)

**Ordering guarantee:** vcode emits `tool_call` event before calling
`permissions.check()`, so when the permission handler runs, the id is already
minted at `queue[0]`. This ordering must not change in agent.ts.

---

## Permission delegation

`session.permissions.setPromptHandler()` is called at the start of every
`handleSessionPrompt`. The handler:

1. `peekId(toolName)` → get already-minted `toolCallId`
2. `callClient('session/request_permission', { sessionId, toolCall, options })` → await Zed dialog
3. Map outcome to vcode decision:

| ACP outcome | vcode decision |
|---|---|
| `allow_always` (optionId) | `'always'` (saves to `alwaysAllowed`, persists to disk) |
| `allow_once` (optionId) | `'yes'` |
| `cancelled` (outcome.outcome) | sets `activePrompt.cancelled`, calls `agent.abort()`, returns `'no'` |
| anything else | `'no'` |

**Response shape** (Zed sends nested, with flat string fallback):
```ts
type PermResp =
  | { outcome?: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }
  | { outcome?: string };
```

**Outbound option shape** (uses `optionId/name/kind`, not `id/label`):
```json
{ "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" }
```

Safe tools (`read_file`, `glob`, `grep`, `git`, etc.) are auto-allowed by
`PermissionManager.SAFE_TOOLS` — the dialog never fires for them.

---

## Session persistence and auto-save

**Problem solved:** Zed's Threads Sidebar stores thread UUIDs from `session/new`.
When the user clicks a thread, Zed calls `session/load` with that UUID. Without
auto-save, no file existed on disk with that UUID, causing "Session not found."

**Fix:** `AcpSession.autoSave()` — called in `handleSessionPrompt`'s `finally`
block (non-fatal, silently catches errors):

```ts
async autoSave(): Promise<void> {
  const raw = this.agent.getContext().getMessages();
  if (raw.length === 0) return;
  // Strip <think>...</think> and orphan </think> content from saved messages
  const messages = raw.map(m => { ... });
  const name = autoName(messages);
  await saveSession(name, messages, model, mode, this.cwd, this.sessionId);
}
```

`this.sessionId` is passed as `existingId` to `saveSession`, so the file on
disk has the same UUID Zed stored. `loadSession(uuid)` finds it.

**Think-tag stripping:** Saved assistant messages are cleaned before writing:
1. Strip complete `<think>...</think>` blocks (regex)
2. Strip orphan leading reasoning text ending at `</think>` (Qwen3 vLLM pattern)

This keeps session files readable and prevents `</think>` artifacts in resumed
conversations.

**Session IDs:** ACP sessions created by `session/new` use UUID format. TUI
sessions use base-36 timestamp IDs (e.g. `mp75z2vo`). Both appear in
`session/list` and are loadable via `session/load`. The stored ID becomes the
active session ID — there is no new UUID on load. `session/load` response has
no `sessionId` field (ACP spec).

---

## MCP forwarding

Zed's `context_servers` arrive as flat ACP `mcpServers` in `session/new`,
`session/load`, and `session/resume` params.

**Flat ACP shapes** (what Zed actually sends):

Stdio:
```json
{ "name": "server", "command": "/path/to/exe", "args": [], "env": [{"name":"K","value":"V"}] }
```

SSE:
```json
{ "type": "sse", "name": "server", "url": "https://...", "headers": [{"name":"Authorization","value":"Bearer ..."}] }
```

HTTP (streamable):
```json
{ "type": "http", "name": "server", "url": "https://...", "headers": [...] }
```

`AcpMcpServer` type in `acp-session.ts` matches this. Converter populates
vcode's `McpServerConfig` and calls `connectAndDiscover()`. Clients are kept
on `AcpSession` and closed on `session/close`.

`mcpCapabilities` advertises: `{ http: true, sse: true }`.

Currently configured in Zed (forwarded to vcode):
1. `newsfeed-read` — stdio, SSH to Palomino (absolute node path, no nvm)
2. `burnrate` — stdio, SSH to 10.0.153.99
3. `newsfeed-action` — HTTP, `http://10.0.153.99:4040/mcp`, bearer token

---

## configOptions shape (Phase 4)

Returned in `session/new`, `session/load`, `session/resume` responses and from
`session/set_config_option`:

```json
{
  "configOptions": [
    {
      "id": "mode",
      "name": "Mode",
      "category": "mode",
      "type": "select",
      "currentValue": "act",
      "options": [
        { "value": "act",  "name": "Act",  "description": "Code and use tools" },
        { "value": "plan", "name": "Plan", "description": "Plan without mutating tools" },
        { "value": "chat", "name": "Chat", "description": "Conversation and read-only context" }
      ]
    },
    {
      "id": "model",
      "name": "Model",
      "category": "model",
      "type": "select",
      "currentValue": "<current model>",
      "options": [ ... discovered models ... ]
    },
    {
      "id": "effort",
      "name": "Effort",
      "category": "thought_level",
      "type": "select",
      "currentValue": "medium",
      "options": [
        { "value": "low",    "name": "Low" },
        { "value": "medium", "name": "Medium" },
        { "value": "high",   "name": "High" }
      ]
    }
  ],
  "modes": {
    "currentModeId": "act",
    "availableModes": [
      { "id": "act",  "name": "Act",  "description": "Code and use tools" },
      { "id": "plan", "name": "Plan", "description": "Plan without mutating tools" },
      { "id": "chat", "name": "Chat", "description": "Conversation and read-only context" }
    ]
  }
}
```

`session/set_config_option` params: `{ sessionId, configId, value }` (not `key`).
Response: full `configOptions` array (not just the changed option).

---

## Cancellation and active prompt state

Per-session state:
```ts
activePrompt: { requestId: string | number; generation: number; cancelled: boolean } | null
```

- `session/prompt` sets `activePrompt`, runs in background (not awaited in dispatch)
- `session/cancel` sets `activePrompt.cancelled = true`, calls `agent.abort()`
- The running prompt checks `activePrompt.cancelled` at each `AgentEvent` iteration
- `finally` block always calls `sendResult(id, { stopReason })`:
  - `"end_turn"` — normal completion
  - `"cancelled"` — abort was triggered
- Late cancels (arriving after prompt already responded) are no-ops (generation check)
- Concurrent prompts on the same session: rejected with `-32000` if `activePrompt` is set

---

## session/load replay

`session/load` replays conversation history via `session/update` notifications
before responding:

| Stored message role | Replay update |
|---|---|
| `user` (text) | `user_message_chunk` |
| `assistant` (text) | `agent_message_chunk` |
| `assistant` (tool_calls) | one `tool_call` per call (status `completed`) |
| `tool` | `tool_call_update` (status `completed`, positional match) |
| `system` | skipped |

Tool call IDs during replay use `replay_N` format (counter-based).

`session/resume` performs the same context restore but skips replay.

---

## Open questions for Codex

### V1 — Does Zed show user messages in the Threads Sidebar after `session/load`?

We emit `user_message_chunk` during replay (Codex correction #3 said to include
user messages). Is Zed actually rendering both sides of the conversation in the
thread panel, or just the agent side? If user messages aren't showing, it's
possible `user_message_chunk` is not the right update type — or Zed renders them
differently.

### V2 — `info` event type: any places we missed?

We added `'info'` to `AgentEvent` type and handle it in both TUI switch blocks
in `index.ts` and in `acp.ts`. Are there other consumers of `AgentEvent` in the
codebase that need a `case 'info'` added (e.g. subagents, the API server, the
benchmark runner)?

### V3 — `model_switch` as `config_option_update`

When `agent.run()` emits `model_switch`, we send a `config_option_update`
session/update with the new configOptions. Does Zed actually update its model
picker in the UI from this, or does it only read `configOptions` from the initial
`session/new` response and not from mid-turn updates?

### V4 — ACP protocol version

We're negotiating `protocolVersion: 1`. Has the ACP protocol version bumped
since May 2026? If Zed sends a higher version in `initialize.params.protocolVersion`,
we should negotiate down to 1 (return 1 in the response). Currently we just
return 1 unconditionally — that should be fine as long as the protocol is
backward-compatible, but worth confirming.

---

## Wire shapes reference

### session/update — agent_message_chunk
```json
{ "jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"..."}}}}
```

### session/update — agent_thought_chunk
```json
{ "jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"..."}}}}
```

### session/update — tool_call
```json
{ "jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"tool_call","toolCallId":"call_001","title":"Running bash","kind":"execute","status":"pending","rawInput":{"command":"npm test"}}}}
```

Valid `kind`: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`
Valid `status`: `pending`, `in_progress`, `completed`, `failed`

### session/update — tool_call_update (success)
```json
{ "jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_001","status":"completed","content":[{"type":"content","content":{"type":"text","text":"output"}}],"rawOutput":{"success":true,"output":"output"}}}}
```

### session/update — tool_call_update (failure)
```json
{ "jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_001","status":"failed","content":[{"type":"content","content":{"type":"text","text":"Error: ..."}}],"rawOutput":{"success":false,"error":"..."}}}}
```

### session/prompt response
```json
{ "jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}
```
Valid `stopReason`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`

### session/request_permission (agent → Zed)
```json
{ "jsonrpc":"2.0","id":"client_1","method":"session/request_permission","params":{"sessionId":"...","toolCall":{...},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},...]}}
```

### session/request_permission response (Zed → agent)
```json
{ "jsonrpc":"2.0","id":"client_1","result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}
```
or:
```json
{ "jsonrpc":"2.0","id":"client_1","result":{"outcome":{"outcome":"cancelled"}}}
```

### session/list response
```json
{ "sessions":[{"sessionId":"...","cwd":"/abs/path","title":"Session name","updatedAt":"2026-05-15T..."}],"nextCursor":null}
```
