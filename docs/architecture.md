---
title: "Architecture"
description: "Technical architecture: file structure, modules, agent loop, context management, and system design."
weight: 15
---

# Architecture

VEEPEE Code is a TypeScript application built on Node.js 20+. It uses the Ollama JavaScript SDK for model inference, Zod for schema validation, marked + marked-terminal for markdown rendering, and raw terminal escape codes for the TUI. This document covers the technical design.

## File Structure

```
veepee-code/
├── src/
│   ├── index.ts           # Entry point, main loop, command handler
│   ├── agent.ts           # ReAct agent loop, mode management, roster integration
│   ├── models.ts          # Model discovery, ranking, auto-switching
│   ├── context.ts         # System prompt builder, context manager
│   ├── config.ts          # .env loading, Config interface
│   ├── permissions.ts     # Permission system
│   ├── api.ts             # OpenAI-compatible HTTP API server
│   ├── benchmark.ts       # Benchmark runner, test suite, roster builder
│   ├── sessions.ts        # Session save/load/resume/list
│   ├── setup.ts           # Integration validation
│   ├── render.ts          # Markdown rendering and legacy formatters
│   ├── types.d.ts         # Module declarations
│   ├── tools/
│   │   ├── types.ts       # ToolDef, ToolResult, Zod-to-Ollama converter
│   │   ├── registry.ts    # ToolRegistry class
│   │   ├── coding.ts      # read_file, write_file, edit_file, glob, grep, bash, git, list_files
│   │   ├── web.ts         # web_fetch, http_request, web_search
│   │   ├── devops.ts      # docker, system_info
│   │   ├── home.ts        # weather, home_assistant, timer
│   │   ├── social.ts      # mastodon, spotify
│   │   ├── google.ts      # email, calendar, google_drive, google_docs, google_sheets, notes
│   │   └── news.ts        # news
│   └── tui/
│       ├── index.ts       # TUI class: rendering, input, command palette, turn tracker
│       ├── screen.ts      # Terminal primitives (cursor, clear, write, wrap)
│       ├── theme.ts       # Color palette, box drawing, icons
│       └── logo.ts        # ASCII art logo generation
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
│   ├── coding.ts ──── types.ts
│   ├── web.ts ─────── types.ts, config.ts
│   ├── devops.ts ──── types.ts
│   ├── home.ts ────── types.ts, config.ts
│   ├── social.ts ──── types.ts, config.ts
│   ├── google.ts ──── types.ts, config.ts
│   └── news.ts ────── types.ts, config.ts
├── agent.ts ─── config.ts, models.ts, context.ts, tools/registry.ts, permissions.ts, benchmark.ts
├── context.ts ── models.ts, agent.ts (types only)
├── permissions.ts
├── api.ts ────── agent.ts, models.ts, tools/registry.ts
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

Loads environment variables from `.env` files with a defined search order. Returns a typed `Config` object with nullable fields for optional integrations.

Key design decisions:
- First-match .env loading (local > home > XDG > default)
- Null for unconfigured integrations (both required vars must be set)
- Default proxy URL is `http://localhost:11434`; dashboard URL defaults to empty (optional)
- `maxModelSize` (default 40) and `minModelSize` (default 6) control model candidacy

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

**Compaction algorithm:**
When estimated tokens exceed 80% of the 32K budget and there are more than 12 messages:
1. Keep the first message (initial context)
2. Insert a summary message noting how many messages were dropped
3. Keep the 10 most recent messages

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
2. Speed check: send a prompt, allow 60s cold start, measure generation tok/s. Filter out <1 tok/s.
3. Full benchmark on survivors: 10 test cases + context probing
4. Build roster: assign best model per role based on scores + speed
5. Save results and roster to `~/.veepee-code/benchmarks/`

**Roster building logic:**
- **act:** Best overall score with >2 tok/s
- **plan:** Best reasoning score with >1 tok/s
- **chat:** Fastest with good instruction following (speed weighted heavily), >3 tok/s
- **code:** Best code generation (60%) + editing (40%) combined, >2 tok/s
- **search:** Fastest with good tool calling (speed weighted 8x), >3 tok/s

**Test validation functions** are deterministic -- they check for specific strings, patterns, and structural elements in the model's response.

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

- `registerCodingTools()` -- Always returns 8 tools
- `registerWebTools(config)` -- Returns 2-3 tools (web_search conditional on SearXNG URL)
- `registerDevOpsTools()` -- Returns 2 tools
- `registerHomeTools(config)` -- Returns 1-3 tools (HA conditional)
- `registerSocialTools(config)` -- Returns 0-2 tools (all conditional)
- `registerGoogleTools(config)` -- Returns 0-6 tools (all conditional)
- `registerNewsTools(config)` -- Returns 0-1 tools (conditional)

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

- `/v1/chat/completions` -- Consumes the agent's event stream, translating events to OpenAI SSE format (with `veepee_code` custom extensions for tool calls/results) or a single JSON response
- `/v1/models` -- Maps `ModelProfile[]` to OpenAI model list format with custom fields
- `/api/tools` -- Simple tool enumeration
- `/api/execute` -- Direct tool execution (bypasses LLM)
- `/api/status` -- Session state snapshot
- `/health` -- Liveness probe

The server binds to `0.0.0.0` and auto-increments the port if `EADDRINUSE`.

### TUI (`tui/`)

The TUI is built on raw terminal escape codes:

- **`screen.ts`** -- Primitives: `moveTo`, `writeAt`, `clearScreen`, `enterAltScreen`, `exitAltScreen`, `wordWrap`, `truncate`, `stripAnsi`, `center`
- **`theme.ts`** -- Color palette (chalk hex colors), box drawing characters, icon definitions
- **`logo.ts`** -- ASCII art "VEEPEE CODE" generation with responsive fallback
- **`index.ts`** -- `TUI` class with full rendering pipeline, command palette, turn tracker

The TUI operates in raw mode (`stdin.setRawMode(true)`) and handles all keystrokes manually. It uses the alternate screen buffer to preserve the user's terminal history.

**Rendering approach:** Full screen clear + redraw on every render call. No incremental updates except during streaming (partial message area update). The render rate is limited by:
- Turn tracker: 500ms interval
- Input: immediate on keystroke
- Stream: on each token

**Markdown rendering:** Assistant messages are rendered through marked + marked-terminal with styled code blocks, headings, bold, italic, links, and horizontal rules.

**Command palette:** Opens when `/` is typed as the first character or `Ctrl+P` is pressed. Renders above the input box as a bordered menu with filter-as-you-type, arrow key navigation, and immediate submission for argument-free commands.

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

4. **Raw terminal escape codes for TUI.** No blessed, no ink, no terminal framework. Direct control over rendering with minimal dependencies.

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
| `dotenv` | .env file loading |
| `glob` | File pattern matching |
| `marked` + `marked-terminal` | Markdown rendering for assistant output in the TUI |
| `tsx` | TypeScript execution for development |
| `typescript` | Compiler |

Total dependency footprint is intentionally small -- no Express, no React, no terminal UI frameworks.
