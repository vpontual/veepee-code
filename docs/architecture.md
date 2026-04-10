---
title: "Architecture"
description: "Technical architecture: file structure, modules, agent loop, context management, and system design."
weight: 15
---

# Architecture

VEEPEE Code is a TypeScript application built on Node.js 20+. It uses the Ollama JavaScript SDK for model inference, Zod for schema validation, marked + marked-terminal for markdown rendering, and Ink (React) for the TUI (with raw stdin bypassing Ink for keystroke handling). This document covers the technical design.

## File Structure

```
veepee-code/
├── src/
│   ├── index.ts           # Entry point, main loop, command handler
│   ├── agent.ts           # ReAct agent loop, mode management, roster integration
│   ├── models.ts          # Model discovery, ranking, auto-switching
│   ├── context.ts         # System prompt builder, context manager
│   ├── config.ts          # vcode.config.json loading, .env→JSON migration, Config interface
│   ├── permissions.ts     # Permission system
│   ├── api.ts             # OpenAI-compatible HTTP API server
│   ├── benchmark.ts       # Benchmark runner, test suite, roster builder
│   ├── knowledge.ts       # KnowledgeState class (compressed context, serialize/deserialize, disk persistence)
│   ├── subagent.ts        # SubAgent + SubAgentManager (search/review/summarize roles)
│   ├── worktree.ts        # Git worktree create/list/cleanup
│   ├── sessions.ts        # Session save/load/resume/list
│   ├── sandbox.ts         # SandboxManager — per-session temp directory
│   ├── preview.ts         # PreviewManager — run scripts, serve HTML
│   ├── sync.ts            # SyncManager — WebDAV push/pull sessions
│   ├── rc.ts              # Remote Connect route handlers, SSE, permission queue
│   ├── rc-ui.ts           # Remote Connect web UI (inline HTML/CSS/JS)
│   ├── setup.ts           # Integration validation
│   ├── render.ts          # Markdown rendering and legacy formatters
│   ├── types.d.ts         # Module declarations
│   ├── tools/
│   │   ├── types.ts       # ToolDef, ToolResult, Zod-to-Ollama converter
│   │   ├── registry.ts    # ToolRegistry class
│   │   ├── coding.ts      # read_file, write_file, edit_file, glob, grep, bash, git, github, list_files, update_memory
│   │   ├── web.ts         # web_fetch, http_request, web_search (conditional)
│   │   ├── devops.ts      # docker, system_info
│   │   └── remote.ts      # discoverRemoteTools — fetches and proxies tools from a remote agent
│   └── tui/
│       ├── index.ts       # TUI class: thin imperative wrapper over Ink, raw stdin keystroke handler
│       ├── App.tsx        # React/Ink root with useReducer-based state management
│       ├── reducer.ts     # Pure reducer (testable, no React dependency)
│       ├── components/    # 16 React components (Conversation, MessagesArea, InputBox, CommandMenu, ...)
│       ├── hooks/         # useScrollable, useMouseScroll
│       ├── screen.ts      # Raw terminal primitives (used by wizard, not by main TUI)
│       ├── theme.ts       # Color palette, box drawing, icons
│       ├── logo.ts        # ASCII art logo generation
│       ├── keybindings.ts # Raw keystroke → named action map (with user overrides)
│       └── vim.ts         # Optional vim-style input bindings
├── test/                  # 326 unit tests across 21 files (Vitest)
├── vitest.config.ts       # Vitest configuration
├── dist/                  # Compiled JavaScript output
├── docs/                  # Documentation (this site)
├── install.sh             # One-liner installer
├── package.json           # Dependencies and scripts
└── tsconfig.json          # TypeScript configuration
```

## Module Dependency Graph

```
index.ts
├── config.ts
├── models.ts ─── config.ts
├── tools/
│   ├── registry.ts ─── types.ts
│   ├── coding.ts ──── types.ts, ignore.ts
│   ├── web.ts ─────── types.ts, config.ts
│   ├── devops.ts ──── types.ts
│   └── remote.ts ──── types.ts (proxies a configured remote agent's tool catalog)
├── agent.ts ─── config.ts, models.ts, context.ts, tools/registry.ts, permissions.ts, benchmark.ts, knowledge.ts
├── context.ts ── models.ts, agent.ts (types only), knowledge.ts
├── knowledge.ts ─ (standalone, serializable)
├── subagent.ts ── agent.ts, models.ts, tools/registry.ts
├── worktree.ts ── (standalone, shells out to git)
├── permissions.ts
├── sandbox.ts ── (standalone, fs operations)
├── preview.ts ── sandbox.ts (for path resolution)
├── sync.ts ───── sessions.ts (getSessionDir)
├── rc.ts ─────── agent.ts, permissions.ts, preview.ts, sessions.ts, rc-ui.ts
├── rc-ui.ts ──── (standalone, returns HTML string)
├── api.ts ────── agent.ts, models.ts, tools/registry.ts, rc.ts (optional)
├── benchmark.ts ─ models.ts
├── sessions.ts ── agent.ts (types only), tui/theme.ts
├── setup.ts ──── config.ts, tui/theme.ts
├── render.ts
└── tui/
    ├── index.ts ── theme.ts, screen.ts, logo.ts
    ├── screen.ts
    ├── theme.ts
    └── logo.ts ── theme.ts
```

## Core Components

### Config (`config.ts`)

Loads configuration from `~/.veepee-code/vcode.config.json`. Returns a typed `Config` object with nullable fields for optional integrations. On first load, `migrateEnvToJson()` automatically converts any legacy `.env` file to the new JSON format and renames the old file to `.env.backup`.

Key design decisions:
- Single JSON config file at `~/.veepee-code/vcode.config.json`
- Null for unconfigured integrations (the `sync`, `rc`, `remote`, `langfuse` fields)
- Default proxy URL is `http://localhost:11434`; dashboard URL defaults to empty (optional)
- `maxModelSize` (default 40) and `minModelSize` (default 12) control model candidacy

### Model Manager (`models.ts`)

Discovers, scores, ranks, and manages model selection.

**Discovery flow:**
1. Three parallel API calls: tags (proxy), servers (dashboard, if configured), discoveries (dashboard, if configured)
2. Merge data into `ModelProfile` objects with deduplication
3. Infer capabilities from model names when discovery data is missing
4. Compute scores and assign tiers
5. Sort by score descending

**Default selection flow:**
1. User override (`VEEPEE_CODE_MODEL`) takes priority
2. If benchmark results exist, use the top-ranked model within size limits with decent speed (>2 tok/s)
3. Filter by tool support + within `minModelSize`/`maxModelSize`
4. Fallback: any model with tool support, then any model at all

**Auto-switching algorithm:**
1. Track conversation signals (file ops, errors, tool calls, message length, files touched)
2. Compute complexity score from signals
3. Map complexity to target tier (heavy at 8+, standard otherwise -- never auto-downgrades to light)
4. If current model is in the wrong tier, switch to the best model in the target tier within size limits
5. Cooldown: minimum 3 turns between switches

### Agent (`agent.ts`)

The core ReAct (Reasoning + Acting) loop with mode management and roster integration.

**Input preprocessing:**
- `@file` expansion: references like `@src/index.ts` in user messages are detected and expanded inline with the file contents before being sent to the model.
- Image detection: image file paths in user messages are detected and attached as vision inputs when the model supports it.

**Abort handling:** An `AbortController` is wired through the agent loop. Pressing Ctrl+C during generation aborts the current Ollama request and yields a `done` event, returning control to the user without killing the process.

**Effort levels:** The agent supports configurable effort levels that control how aggressively it uses tools and how thorough its responses are.

**Mode management:**
- Loads the model roster from `~/.veepee-code/benchmarks/roster.json` on construction
- `/plan` uses `roster.plan` model (fallback: heaviest with thinking)
- `/chat` uses `roster.chat` model (fallback: fast standard-tier)
- `/act` uses `roster.act` model (fallback: previous model)

**Planning intent auto-detection:**
In act mode, user messages are tested against regex patterns for planning keywords (plan, design, architect, think through, etc.). If detected, the agent automatically enters plan mode with a model switch event.

**Loop structure:**

```
for each turn (up to maxTurns):
  1. Check for auto-model-switch based on conversation signals
  2. Build messages array: [system prompt, ...conversation history]
  3. Stream LLM response with thinking detection
  4. Parse tool calls from the response
  5. If no tool calls → done (yield 'done' event)
  6. For each tool call:
     a. Check permissions
     b. Execute tool
     c. Add result to context
  7. Continue loop (model sees tool results and generates next response)
```

**Event-driven architecture:** The agent is an async generator that yields `AgentEvent` objects:

```typescript
type AgentEvent = {
  type: 'text' | 'tool_call' | 'tool_result' | 'model_switch'
       | 'thinking' | 'done' | 'error' | 'permission_denied';
  content?: string;
  name?: string;
  args?: Record<string, unknown>;
  success?: boolean;
  error?: string;
  from?: string;
  to?: string;
};
```

This design decouples the agent logic from the rendering. The TUI, API, and `runSync` method all consume the same event stream.

**Thinking detection:**
The agent detects `<think>` and `</think>` tags in streamed output (used by Qwen, DeepSeek). Content inside think tags is buffered and emitted as `thinking` events. The `think: true` option is sent to Ollama in plan mode for native thinking support.

### Context Manager (`context.ts`)

Manages the conversation history and system prompt.

**Responsibilities:**
- Build and cache the system prompt from template, project tree, and VEEPEE.md
- Maintain the message array (user, assistant, tool results)
- Track conversation signals for model switching
- Estimate token usage (characters / 4)
- Compact conversation when context pressure builds

**Sliding window:**
The context manager maintains a sliding window of the 6 most recent messages. When the window is exceeded, older messages are compressed into the knowledge state rather than being discarded outright.

**Knowledge state injection:**
On each turn, the serialized `KnowledgeState` is injected into the system prompt, giving the model a compressed summary of the full conversation history (files seen, decisions made, errors encountered) without consuming the raw message tokens.

**Compaction algorithm:**
When estimated tokens exceed 80% of the 32K budget and there are more than 12 messages:
1. Keep the first message (initial context)
2. Insert a summary message noting how many messages were dropped
3. Keep the 6 most recent messages (sliding window)

**Project tree caching:**
The file tree is computed once and cached. It is invalidated when file operations occur (write_file, edit_file modify the filesystem), ensuring new files appear in subsequent turns.

**VEEPEE.md loading:**
Walks up from CWD checking for VEEPEE.md at each level (up to 5 levels), plus `~/.veepee-code/VEEPEE.md`. All found files are included with source annotations.

### Session Manager (`sessions.ts`)

Handles saving, loading, listing, and resuming conversation sessions.

**Storage:** Sessions are saved as JSON files at `~/.veepee-code/sessions/` with filenames like `{id}-{slugified-name}.json`.

**Session data includes:** ID, name, model, mode, CWD, messages array, creation/update timestamps, message count, tool call count.

**Auto-naming:** If no name is provided to `/save`, the first user message is used (truncated to 40 chars at a word boundary).

**Find/resume:** Supports exact match, starts-with, and contains matching on session names.

### Benchmark System (`benchmark.ts`)

The benchmark runner with smart first-launch mode and roster building.

**Smart benchmark flow:**
1. Filter candidates: models with tool support (skip embedding-only)
2. Speed check: preloads the model before measuring to avoid cold-start skew, then measures generation tok/s. Filter out <1 tok/s.
3. Full benchmark on survivors: 10 test cases + optional context probing (tests the model's ability to recall information placed earlier in a long context)
4. Build roster: assign best model per role based on scores + speed
5. Save results and roster to `~/.veepee-code/benchmarks/`

**Roster building logic:**
- **act:** Best overall score with >2 tok/s
- **plan:** Best reasoning score with >1 tok/s
- **chat:** Fastest with good instruction following (speed weighted heavily), >3 tok/s
- **code:** Best code generation (60%) + editing (40%) combined, >2 tok/s
- **search:** Fastest with good tool calling (speed weighted 8x), >3 tok/s

**Test validation functions** are deterministic -- they check for specific strings, patterns, and structural elements in the model's response.

### Knowledge State (`knowledge.ts`)

The `KnowledgeState` class provides compressed context persistence for v0.2.0. Instead of keeping the full conversation history, the knowledge state captures the essential information in a structured, serializable format.

**Responsibilities:**
- Track files seen, decisions made, errors encountered, and key facts discovered during a session
- Serialize to a compact text format suitable for injection into the system prompt
- Deserialize from disk to resume context across sessions
- Persist to `~/.veepee-code/knowledge/` as JSON files

The knowledge state is the foundation of the "compressed knowledge state" approach in v0.2.0 -- replacing full conversation history replay with an AI-readable context dump.

### SubAgent System (`subagent.ts`)

The `SubAgent` and `SubAgentManager` enable the main agent to delegate specialized tasks to lightweight sub-agents with constrained roles.

**Available roles:**
- **search** -- Focused on finding information in the codebase using grep, glob, and read_file
- **review** -- Code review with a critical eye, checking for bugs, style issues, and improvements
- **summarize** -- Condense large amounts of information into concise summaries

Each sub-agent gets a role-specific system prompt and a limited tool set. The `SubAgentManager` handles lifecycle, ensuring sub-agents are spun up and torn down cleanly.

### Sandbox Manager (`sandbox.ts`)

Provides a per-session scratch directory at `~/.veepee-code/sandbox/{sessionId}/` for temporary files, experiments, and scratch code.

**Key operations:**
- `getPath()` — Lazy-creates and returns the sandbox directory
- `list()` — Returns file info (name, size, modified date)
- `keep(file, dest?)` — Moves a file from sandbox to the real workspace (rename or copy+unlink for cross-filesystem)
- `clean()` — Removes the entire session sandbox directory
- `cleanupStale()` — Static method called on startup to remove sandbox dirs older than 24 hours
- `resolvePath(input)` — Resolves `sandbox:filename` prefixed paths

The sandbox path is injected into the system prompt via the `{{SANDBOX}}` placeholder so the model knows about it.

### Preview Manager (`preview.ts`)

Runs scripts and serves HTML files for inline preview.

**Script execution:** Dispatches by file extension (`.py` → `python3`, `.sh` → `bash`, `.js` → `node`, `.ts` → `npx tsx`, `.rb` → `ruby`). Scripts run with a 30-second timeout and capture stdout+stderr.

**Static file server:** A Node.js `http.createServer` that serves files from a directory with proper MIME types. Auto-picks a port from 8485+ (increments on EADDRINUSE). Used for HTML preview and reused by Remote Connect.

**Cross-platform browser open:** Uses `open` on macOS and `xdg-open` on Linux.

### Sync Manager (`sync.ts`)

Pushes and pulls session files to/from a WebDAV server (Nextcloud, ownCloud, etc.) using Node.js built-in `https`/`http` modules — no additional dependencies.

**WebDAV operations (~100 lines):**
- `webdavPut(url, body)` — Upload a file
- `webdavGet(url)` — Download a file
- `webdavPropfind(url)` — List directory contents (parses XML response)
- `webdavMkcol(url)` — Create remote directory

**Conflict resolution:** Compares `updatedAt` timestamps — newer wins. Local files are only overwritten if the remote version is more recent.

**What syncs:** Session JSON files and knowledge state files. Sandbox files are NOT synced (ephemeral by design).

### Remote Connect (`rc.ts` + `rc-ui.ts`)

A phone-accessible web chat UI that shares the TUI session. One agent, two views.

**`rc-ui.ts`:** A single function that returns ~340 lines of inline HTML/CSS/JS as a template literal. Mobile-first responsive design, dark theme matching TUI colors, EventSource for SSE streaming, token auth via localStorage.

**`rc.ts` routes:**
- `GET /rc` — Serve the web UI HTML
- `GET /rc/stream` — SSE event stream mirroring agent events (text, tool_call, tool_result, done, error, permission_request)
- `POST /rc/send` — Send a user message to the agent
- `GET /rc/sessions` — List sessions
- `POST /rc/resume` — Resume a session
- `POST /rc/approve` — Approve/deny a tool permission request
- `POST /rc/preview` — Preview a file

**Permission handling:** When RC clients are connected and a tool needs permission, a `permission_request` SSE event is emitted. The web UI shows approve/deny/always buttons. 60-second timeout auto-denies. TUI takes priority if both are active.

**Networking:** When RC is enabled, the API server binds to `0.0.0.0` instead of `127.0.0.1`, and CORS allows any origin (auth via token protects access). Designed for use with Twingate or direct LAN access.

### Git Worktree Manager (`worktree.ts`)

Manages Git worktrees for parallel branch work without disturbing the main working directory.

**Operations:**
- **create** -- Create a new worktree for a branch at a specified path
- **list** -- Enumerate active worktrees
- **cleanup** -- Remove worktrees and prune stale references

### System Prompt

The system prompt has been slimmed from ~3000 tokens to ~800 tokens in v0.2.0. The reduction is possible because the knowledge state now carries contextual information that was previously baked into verbose prompt instructions.

### Tool System

#### Type System (`tools/types.ts`)

Every tool implements the `ToolDef` interface:

```typescript
interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}
```

The `toOllamaTool()` function converts Zod schemas to the JSON Schema format that the Ollama API expects for tool calling. It handles optional fields, enum types, arrays, and descriptions.

Return values use the `ok()` and `fail()` helper functions that return `ToolResult` objects.

#### Registry (`tools/registry.ts`)

The `ToolRegistry` is a simple Map-based container:

- `register(tool)` -- Add a tool
- `execute(name, args)` -- Validate args with Zod, then execute. Returns `ToolResult`.
- `toOllamaTools()` -- Convert all tools to Ollama format
- `list()`, `names()`, `count()` -- Enumeration

Argument validation happens at the registry level. If Zod parsing fails, the tool is not executed and a descriptive error is returned.

#### Tool Categories

Tools are organized into registration functions per category:

- `registerCodingTools(ignoreManager)` -- Always returns 10 tools (`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`, `git`, `github`, `list_files`, `update_memory`)
- `registerWebTools(config)` -- Returns 2-3 tools (`web_search` conditional on SearXNG URL)
- `registerDevOpsTools()` -- Returns 2 tools (`docker`, `system_info`)
- `discoverRemoteTools(remote, localToolNames)` -- Returns 0+ tools fetched from a configured remote agent's `${url}/dashboard/api/tools` endpoint. Each remote tool is registered as native (with a `[remote]` description prefix). Local tools take priority — if a remote tool name collides with a local one, it is skipped. Execution is proxied via HTTP. This is how integrations like Home Assistant, Mastodon, Spotify, Gmail, Calendar, Drive, Docs, Sheets, Tasks, news, weather, and timers are surfaced — they live in a separate agent (e.g. Llama Rider), not in VEEPEE Code itself.

### Permission Manager (`permissions.ts`)

Three-tier permission check:

```
dangerous_pattern_check → safe_tool_check → persisted/session_check → prompt
```

Dangerous patterns are hard-coded regex checks against specific tool + argument combinations. These always prompt, even for always-allowed tools.

Persistence is a simple JSON file at `~/.veepee-code/permissions.json`.

The prompt handler is injectable -- the TUI sets a custom handler that uses the terminal permission prompt (y/a/n). In API mode, the default handler auto-allows everything.

### API Server (`api.ts`)

A raw Node.js `http.createServer` (no Express, no framework). Endpoints:

- `/v1/chat/completions` -- Consumes the agent's event stream, translating events to standard OpenAI format: non-streaming responses include a `tool_calls` array in the assistant message; streaming responses emit `tool_calls` deltas in standard OpenAI format. Legacy `veepee_code` extensions are still included for backwards compatibility. Incoming `tools` definitions in the request are honored and constrain the agent to the client's tool set.
- `/v1/models` -- Maps `ModelProfile[]` to OpenAI model list format with custom fields
- `/api/tools` -- Simple tool enumeration
- `/api/execute` -- Direct tool execution (bypasses LLM), gated behind `"apiExecute": true` in `vcode.config.json`
- `/api/status` -- Session state snapshot
- `/health` -- Liveness probe

The server binds to `127.0.0.1` (localhost only) by default. When Remote Connect is enabled (`rc.enabled: true`), it binds to `0.0.0.0` and CORS allows any origin. Auto-increments the port if `EADDRINUSE`. Bearer token auth is supported via the `apiToken` config field. RC routes (`/rc/*`) are handled by `rc.ts` when enabled, taking priority over other route matching.

### TUI (`tui/`)

The TUI is built on **Ink (React)** with raw stdin bypassing Ink for keystroke handling:

- **`App.tsx`** -- Root React component using `useReducer + forwardRef + useImperativeHandle`. Renders all 16 sub-components based on the reducer state.
- **`reducer.ts`** -- Pure reducer (no React dependency, fully testable). Holds view, messages, input, scroll, model info, stats, stream state, turn tracker, command menu, model selector, permission queue, type-ahead queue, etc.
- **`index.ts`** -- `TUI` class is a thin imperative wrapper over Ink. Calls `render(<App ref={appRef}>)`, exposes methods that dispatch reducer actions through the ref. Sets up raw stdin (`stdin.setRawMode(true)`) and handles all keystrokes via `handleKey()` — Ink's `useInput` is kept active just to maintain raw mode but isn't used for actual input.
- **`components/`** -- 16 React components: `WelcomeScreen`, `Conversation`, `MessagesArea`, `MessageBlock`, `VirtualMessageList`, `InputBox`, `CommandMenu`, `ProgressBar`, `StatusBar`, `TurnTracker`, `DiffView`, `HistorySearch`, `WorkspaceSearch`, `ModelCompletion`, `ModelSelector`, `PermissionPrompt`.
- **`hooks/`** -- `useScrollable`, `useMouseScroll`.
- **`keybindings.ts`** -- Maps raw key codes (`\r`, `\x03`, `\x1b[A`, etc.) to named actions. User overrides at `~/.veepee-code/keybindings.json`.
- **`screen.ts`** -- Raw terminal primitives (`moveTo`, `clearScreen`, etc.). **Used by the wizard**, not by the main TUI. The wizard runs *before* Ink mounts so it has to use raw escape codes directly.
- **`theme.ts`** -- Color palette (chalk hex colors), box drawing characters, icon definitions.
- **`logo.ts`** -- ASCII art "VEEPEE CODE" generation with responsive fallback.

The TUI uses the alternate screen buffer (`\x1b[?1049h`) to preserve the user's terminal history.

**Rendering approach:** Ink manages the React reconciliation; the TUI class triggers re-renders by dispatching reducer actions. The `progressBarActive` and `streamActive` flags drive partial updates. Render rate constraints:
- Turn tracker: 500ms interval
- Input: immediate on keystroke
- Stream: token-by-token (Ink handles batching)

**Markdown rendering:** Assistant messages are rendered through `marked + marked-terminal` (`render.ts`) with brand-colored code blocks (terracotta `#E8A87C`), bold, italic, headings, links, and horizontal rules.

**Command palette:** Opens when `/` is typed as the first character or `Ctrl+P` is pressed. Renders above the input box as a bordered menu with filter-as-you-type, arrow key navigation, and immediate submission for argument-free commands.

**Type-ahead:** While the agent is running, keystrokes accumulate in the `queuedInput` reducer slot. On the next `getInput()`, queued text is moved into the active input. Full editing supported during type-ahead (backspace, arrows, paste, Shift+Enter).

## Data Flow

### User Input to Response

```
User types → TUI captures keystroke → resolveInput() →
  main loop receives input →
    if /command → handleCommand() → TUI update
    else → agent.run(input) yields events →
      TUI renders each event (text, tool_call, tool_result, etc.) →
        agent loop continues until 'done' event →
          TUI shows completion badge →
            main loop waits for next input
```

### Tool Execution

```
LLM generates tool call →
  agent extracts tool name + args →
    permission manager checks →
      if denied → yield 'permission_denied', add denial to context →
      if allowed → registry.execute(name, args) →
        Zod validates args →
          tool.execute(params) →
            return ToolResult →
              agent adds to context →
                yield 'tool_result' event →
                  TUI shows result
```

### Model Auto-Switch

```
Each agent turn:
  context.getSignals() →
    modelManager.evaluate(signals) →
      computeComplexity(signals) →
        if complexity changed tier:
          find best model in target tier (within size limits) →
            modelManager.switchTo(model) →
              context.setSystemPrompt(model) →
                yield 'model_switch' event →
                  TUI updates model display
```

## Key Design Decisions

1. **Async generators for the agent loop.** This makes the agent composable -- the TUI, API, and `runSync` all consume the same event stream with different rendering strategies.

2. **Zod for tool schemas.** Single source of truth for validation that converts to both runtime TypeScript types and Ollama JSON Schema format.

3. **No framework for the API server.** A single `createServer` keeps dependencies minimal and startup fast.

4. **Ink (React) for the TUI.** Component-based rendering with `useReducer` state management, but raw stdin bypasses Ink's `useInput` for keystroke handling. The wizard (which runs before Ink mounts) uses raw terminal escape codes directly via `screen.ts` primitives.

5. **Config-driven tool registration.** Tools with missing credentials are simply not registered. The agent never sees tools it cannot use, avoiding hallucinated tool calls.

6. **Event-driven permission system.** The permission handler is injectable, allowing the TUI and API to handle prompts differently without coupling.

7. **Hierarchical VEEPEE.md.** Inspired by how `.gitignore` and `.editorconfig` work -- local overrides global.

8. **Benchmark-driven roster.** No hardcoded model preferences. The smart benchmark discovers what works best on your actual hardware and builds the roster empirically.

## Dependencies

| Package | Purpose |
|---------|---------|
| `ollama` | Ollama JavaScript SDK for model inference |
| `zod` | Schema validation for tool parameters |
| `chalk` | Terminal color output |
| `glob` | File pattern matching |
| `marked` + `marked-terminal` | Markdown rendering for assistant output in the TUI |
| `cli-highlight` | Syntax highlighting for code blocks |
| `ink` + `ink-text-input` + `react` | TUI rendering (component-based, with raw stdin for keystrokes) |
| `qrcode-terminal` | QR code rendering for Remote Connect |
| `langfuse` (optional) | Lazy-loaded observability — agent turn traces |
| `vitest` | Test runner (326 tests across 21 files) |
| `tsx` | TypeScript execution for development |
| `typescript` | Compiler |

The dependency footprint is intentionally small -- no Express (raw `http.createServer`), no Commander (manual argv parsing), no blessed, no dotenv (config has migrated to `vcode.config.json`).
