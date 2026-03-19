---
title: "Terminal UI"
description: "Full-screen TUI: layout, input handling, command palette, turn tracker, streaming, thinking display, and keyboard shortcuts."
weight: 11
---

# Terminal UI

VEEPEE Code uses a full-screen alternate-buffer terminal interface inspired by Claude Code and OpenCode. The TUI manages the welcome screen, conversation view, input handling, command palette, streaming output, tool call visualization, and a live turn tracker.

## Screen Layout

### Welcome Screen

When VEEPEE Code starts (or after `/clear` with no messages), the welcome screen is shown:

```
            ██╗   ██╗███████╗███████╗██████╗ ███████╗███████╗
            ██║   ██║██╔════╝██╔════╝██╔══██╗██╔════╝██╔════╝
            ██║   ██║█████╗  █████╗  ██████╔╝█████╗  █████╗
            ╚██╗ ██╔╝██╔══╝  ██╔══╝  ██╔═══╝ ██╔══╝  ██╔══╝
             ╚████╔╝ ███████╗███████╗██║     ███████╗███████╗
              ╚═══╝  ╚══════╝╚══════╝╚═╝     ╚══════╝╚══════╝

                      ██████╗ ██████╗ ██████╗ ███████╗
                     ██╔════╝██╔═══██╗██╔══██╗██╔════╝
                     ██║     ██║   ██║██║  ██║█████╗
                     ██║     ██║   ██║██║  ██║██╔══╝
                     ╚██████╗╚██████╔╝██████╔╝███████╗
                      ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝

                ╭────────────────────────────────────────────────────────╮
                │ Ask anything... "Fix the bug in auth.ts"               │
                │ Build  qwen3.5:35b 35B (default) Ollama Fleet          │
                ╰────────────────────────────────────────────────────────╯
                        tab tools  ctrl+p commands  /help help

 ~/my-project                                     ● API :8484  v0.1.0 ⚡
```

Components:
- **ASCII art logo** -- Block-pixel "VEEPEE CODE" with the top half (VEEPEE) in warm terracotta and the bottom half (CODE) in white. Falls back to a compact `┃ veepee code ┃` on narrow terminals (<~54 columns).
- **Input box** -- Rounded-corner box with placeholder text, model info line showing active model name/size and provider, and a blinking cursor.
- **Keyboard hints** -- Quick reference below the input box.
- **Status bar** -- Bottom line showing CWD, API port, and version.

### Conversation Screen

After the first message, the layout switches to conversation mode. Messages start at row 3 (rows 1-2 can be clipped by terminal title/tab bars):

```
  │ Fix the off-by-one error in src/utils/paginate.ts

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
3. **Input box** -- Same as welcome screen, with blinking cursor
4. **Status bar** -- CWD, token count, context usage percentage, API port, version

## Message Types

Messages are rendered with distinct visual styles:

| Role | Visual |
|------|--------|
| **User** | Highlighted background (`#2A2A4A`) with blue left border (`│`) and white bold text |
| **Assistant** | Markdown-rendered via marked-terminal (code blocks in terracotta, bold/italic/headings styled, links in sky blue) |
| **Tool call** | Terracotta diamond `◆` with tool name and truncated arguments |
| **Tool result (success)** | Green checkmark `✓` with dimmed output preview (max 3-4 lines). `edit_file` results show red/green colored diffs. |
| **Tool result (error)** | Red cross `✗` with error message |
| **Thinking** | Dimmed, collapsed by default. Shows `◐ Thinking...` (animated: ◐ ◓ ◑ ◒) while active, then `◐ Thought (N lines) preview...` when complete |
| **Model switch** | Yellow `◐ Model: old → new` |
| **System** | Dimmed text for info, errors, and permission prompts |
| **Completion badge** | Dimmed `◇ Build ● model ● N tool calls ● tokens ● tok/s ● time`. Token count uses real Ollama `eval_count` and prompt token counts. |

## Command Palette

The command palette opens when you type `/` as the first character or press `Ctrl+P`. It appears as a bordered menu above the input box, similar to OpenCode's command palette:

- Shows all available commands with descriptions (includes `/rename`, `/add-dir`, `/worktree`, `/effort`, `/benchmark context` among others)
- Filters as you type (e.g., `/be` shows only `/benchmark` commands)
- Navigate with `Up/Down` arrows
- `Enter` selects and submits immediately (for commands without arguments)
- `Tab` accepts the selection but keeps the cursor for typing arguments
- `Esc` closes without selecting
- The highlighted row has a distinct background

## Turn Tracker (Agent Tree View)

While the agent is processing, a live turn tracker appears above the input box. It updates every 500ms and shows:

```
  ⠹ Running... (3 tool calls ● 1.2k tokens ● 4.5s)
  ├─ ✓ read_file 0.3s
  ├─ ✓ grep 0.8s
  └─ ⠹ edit_file
```

Components:
- **Header** -- Animated spinner (braille frames) with running stats (tool count, token estimate, elapsed time)
- **Tool tree** -- Last 5 tool calls with tree connectors (`├─` / `└─`)
- **Status icons** -- Spinning for running, green `✓` for done, red `✗` for error
- **Overflow** -- If more than 5 tool calls, shows `... N earlier` above the visible tree

The tracker disappears when the agent completes, replaced by the completion badge in the message area.

## Streaming

Assistant text streams token-by-token into the message area. During streaming:

- The message area updates in real-time as tokens arrive (full re-render on each token)
- The stream buffer accumulates text that has not yet been committed as a message
- When streaming ends (`endStream`), the buffer is committed as an assistant message
- Tool calls interrupt the stream -- the current text is committed, the tool call is shown, and streaming resumes after the tool result

## Thinking Display

When the model uses `<think>` tags (Qwen, DeepSeek) or native thinking (via the `think` API parameter in plan mode):

1. A pulsing indicator appears: animated frames ◐ ◓ ◑ ◒ with "Thinking..."
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
| `Shift+Enter` | Insert a newline (multi-line input) |
| `Enter` | Submit input (if non-empty) |

### Navigation & Scrolling

| Key | Action |
|-----|--------|
| `Up` | Previous command from history |
| `Down` | Next command in history (or clear) |
| `Shift+Up` / `Page Up` | Scroll message area up |
| `Shift+Down` / `Page Down` | Scroll message area down |
| Trackpad / mouse wheel | Scroll message area |

History stores up to 100 entries and persists for the session.

Auto-scroll always keeps the latest content visible. Scrolling up temporarily disables auto-scroll; scrolling back to the bottom re-enables it.

### Shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Submit `/tools` command (show all tools) |
| `Ctrl+P` | Open command palette (types `/` and shows command menu) |
| `/` | Open command palette (when typed as first character) |
| `Ctrl+L` | Clear screen and message history, return to welcome screen |
| `Ctrl+C` | If the agent is running, interrupts it (shows "Interrupted" and returns to input). Otherwise, clears the current input text. Does not quit. |
| `Ctrl+D` | Quit VEEPEE Code (sends EOF) |

### Paste Detection

When text is pasted into the input (detected by rapid multi-byte sequences), newlines in the pasted content are preserved. This allows pasting multi-line code snippets or text blocks without losing formatting.

### Command Display

Slash commands (e.g., `/model`, `/clear`) are shown as user messages in the conversation area immediately when submitted, providing visual confirmation of the action taken.

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
| Right | Token count, context usage %, API port, version, lightning bolt icon |

Context usage percentage is calculated as `estimated_tokens / 32000 * 100`. This gives a rough indication of how full the context window is.

## Color Theme

VEEPEE Code uses a warm color palette:

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
| User message bg | Dark indigo | `#2A2A4A` |

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

- **Logo** -- Full ASCII art logo requires ~50 columns. Below that, a compact `┃ veepee code ┃` is shown.
- **Input box** -- Maximum 90 columns wide, centered in the terminal.
- **Message area** -- Full-width edge-to-edge layout (the 100-column cap has been removed). Markdown width adapts dynamically to the current terminal size.
- **Resize** -- The TUI re-renders on `process.stdout` resize events.

## Alternate Screen Buffer

VEEPEE Code uses the terminal's alternate screen buffer (`\x1b[?1049h`). This means:

- Your previous terminal content is preserved and restored when VEEPEE Code exits
- No scrollback pollution
- Clean exit on Ctrl+D, `/quit`, or SIGTERM

On fatal errors, the TUI attempts to restore the cursor and exit the alternate screen before printing the error.
