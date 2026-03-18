---
title: "Terminal UI"
description: "Full-screen TUI: layout, input handling, turn tracker, streaming, thinking display, and keyboard shortcuts."
weight: 11
---

# Terminal UI

VEEPEE Code uses a full-screen alternate-buffer terminal interface inspired by Claude Code and OpenCode. The TUI manages the welcome screen, conversation view, input handling, streaming output, tool call visualization, and a live turn tracker.

## Screen Layout

### Welcome Screen

When VEEPEE Code starts (or after `/clear` with no messages), the welcome screen is shown:

```
                ██╗     ██╗      █████╗ ███╗   ███╗ █████╗
                ██║     ██║     ██╔══██╗████╗ ████║██╔══██╗
                ...

                ╭────────────────────────────────────────────────────────╮
                │ Ask anything... "Fix the bug in auth.ts"               │
                │ Build  qwen3.5:35b 35B (default) Ollama Fleet          │
                ╰────────────────────────────────────────────────────────╯
                        tab tools  ctrl+p commands  /help help

 ~/my-project                                     ● API :8484  v0.1.0 ⚡
```

Components:
- **ASCII art logo** -- Block-pixel "LLAMA CODE" in warm terracotta and white. Falls back to a compact version on narrow terminals.
- **Input box** -- Rounded-corner box with placeholder text, model info, and provider name.
- **Keyboard hints** -- Quick reference below the input box.
- **Status bar** -- Bottom line showing CWD, API port, and version.

### Conversation Screen

After the first message, the layout switches to conversation mode:

```
  ▎ Fix the off-by-one error in src/utils/paginate.ts

  ◆ read_file path=src/utils/paginate.ts
    ✓ (45 lines)
  ◆ edit_file path=src/utils/paginate.ts old_string="i <= total" new_string="i < total"
    ✓ Edited src/utils/paginate.ts: -1 +1 lines

  Fixed the off-by-one on line 23. The loop condition was `i <= total`
  which overshot by 1. Changed to `i < total`.

  ◇  Build ● qwen3.5:35b ● 2 tool calls ● 1.2k tokens ● 3.4s

  ╭────────────────────────────────────────────────────────────────╮
  │                                                                │
  │ Build  qwen3.5:35b 35B (default) Ollama Fleet                 │
  ╰────────────────────────────────────────────────────────────────╯
          tab tools  ctrl+p commands  /help help

 ~/my-project                         4,500 tok 14%  ● API :8484  v0.1.0 ⚡
```

Layout regions (top to bottom):
1. **Message area** -- Scrollable history of user messages, assistant responses, tool calls, and tool results
2. **Turn tracker** -- Live view of the current agent turn (appears only while the agent is working)
3. **Input box** -- Same as welcome screen
4. **Status bar** -- CWD, token count, context usage percentage, API port, version

## Message Types

Messages are rendered with distinct visual styles:

| Role | Visual |
|------|--------|
| **User** | Blue left border `▎` with white text |
| **Assistant** | White text, word-wrapped |
| **Tool call** | Orange diamond `◆` with tool name and truncated arguments |
| **Tool result (success)** | Green checkmark `✓` with dimmed output preview (max 3 lines) |
| **Tool result (error)** | Red cross `✗` with error message |
| **Thinking** | Dimmed, collapsed by default. Shows `◐ Thinking...` while active, then summary `◐ Thought (N lines) preview...` |
| **Model switch** | Yellow `◐ Model: old → new` |
| **System** | Dimmed text for info, errors, and permission prompts |
| **Completion badge** | Dimmed `◇ Build ● model ● N tool calls ● tokens ● time` |

## Turn Tracker (Agent Tree View)

While the agent is processing, a live turn tracker appears above the input box. It updates every 500ms and shows:

```
  ⠹ Running... (3 tool calls ● 1.2k tokens ● 4.5s)
  ├─ ✓ read_file 0.3s
  ├─ ✓ grep 0.8s
  └─ ⠹ edit_file
```

Components:
- **Header** -- Animated spinner with running stats (tool count, token estimate, elapsed time)
- **Tool tree** -- Last 5 tool calls with tree connectors (`├─` / `└─`)
- **Status icons** -- Spinning for running, green `✓` for done, red `✗` for error
- **Overflow** -- If more than 5 tool calls, shows `... N earlier` above the visible tree

The tracker disappears when the agent completes, replaced by the completion badge in the message area.

## Streaming

Assistant text streams token-by-token into the message area. During streaming:

- The message area updates in real-time as tokens arrive
- The stream buffer accumulates text that has not yet been committed as a message
- When streaming ends (`endStream`), the buffer is committed as an assistant message
- Tool calls interrupt the stream -- the current text is committed, the tool call is shown, and streaming resumes after the tool result

## Thinking Display

When the model uses `<think>` tags (Qwen, DeepSeek) or native thinking (via the `think` API parameter in plan mode):

1. A pulsing indicator appears: `◐ Thinking...` (with animated frames: ◐ ◓ ◑ ◒)
2. Thinking content accumulates in a buffer
3. When thinking ends, the full content is rendered as a collapsed block:
   ```
   ◐ Thought (15 lines) The user wants to refactor the auth system...
   ```
4. The collapsed format shows the line count and the first line as a preview

Thinking blocks are always dimmed to visually distinguish them from the agent's actual output.

## Input Handling

The TUI uses raw mode input (`process.stdin.setRawMode(true)`) to capture individual keystrokes:

### Text Input

| Key | Action |
|-----|--------|
| Printable characters | Insert at cursor position |
| `Backspace` | Delete character before cursor |
| `Left` / `Right` | Move cursor |
| `Home` / `Ctrl+A` | Move cursor to start |
| `End` / `Ctrl+E` | Move cursor to end |
| `Enter` | Submit input (if non-empty) |

### Navigation

| Key | Action |
|-----|--------|
| `Up` | Previous command from history |
| `Down` | Next command in history (or clear) |

History stores up to 100 entries and persists for the session.

### Shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Submit `/tools` command (show all tools) |
| `Ctrl+P` | Submit `/help` command (show all commands) |
| `Ctrl+L` | Clear screen and message history, return to welcome screen |
| `Ctrl+C` | Clear current input text (does not quit) |
| `Ctrl+D` | Quit VEEPEE Code (sends EOF) |

### Permission Prompts

During permission prompts, only `y`, `a`, `n`, and `Esc` are accepted. All other input is ignored until the prompt is resolved.

## Status Bar

The bottom row shows:

```
 ~/my-project                         4,500 tok 14%  ● API :8484  v0.1.0 ⚡
```

| Section | Content |
|---------|---------|
| Left | Current working directory (with `~` for home) |
| Right | Token count, context usage %, API port, version, llama emoji |

Context usage percentage is calculated as `estimated_tokens / 32000 * 100`. This gives a rough indication of how full the context window is.

## Color Theme

VEEPEE Code uses a warm color palette inspired by llama wool:

| Element | Color | Hex |
|---------|-------|-----|
| Brand / warm | Terracotta | `#E8A87C` |
| Accent / cool | Sky blue | `#85C7F2` |
| Success | Sage green | `#7EC8A0` |
| Error | Soft red | `#E57373` |
| Warning | Warm yellow | `#FFD93D` |
| Text | White | - |
| Dim | Gray | - |
| Dimmer | Dark gray | `#555555` |
| Muted | Medium gray | `#888888` |
| Borders | Dark gray / Sky blue (focused) | `#555555` / `#85C7F2` |

## Box Drawing

The input box uses Unicode rounded corners:

```
╭──────────────────╮
│ Content           │
│ Model info        │
╰──────────────────╯
```

The turn tracker uses tree drawing characters:

```
├── Connected node
└── Last node
```

## Responsive Layout

The TUI adapts to terminal size:

- **Logo** -- Full ASCII art logo requires ~50 columns. Below that, a compact `┃ llama code ┃` is shown.
- **Input box** -- Maximum 90 columns wide, centered in the terminal.
- **Message area** -- Maximum 100 columns wide, centered. Text wraps at the available width.
- **Resize** -- The TUI re-renders on `process.stdout` resize events.

## Alternate Screen Buffer

VEEPEE Code uses the terminal's alternate screen buffer (`\x1b[?1049h`). This means:

- Your previous terminal content is preserved and restored when VEEPEE Code exits
- No scrollback pollution
- Clean exit on Ctrl+D, `/quit`, or SIGTERM

On fatal errors, the TUI attempts to restore the cursor and exit the alternate screen before printing the error.
