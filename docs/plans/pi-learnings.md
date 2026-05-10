# Implementation Plan: pi Learnings

**Source:** Analysis of [earendil-works/pi](https://github.com/earendil-works/pi) `packages/coding-agent` (47k stars, TypeScript) during the 2026-05-09 session. Written to survive Claude Code context resets — everything needed to pick up and implement each phase without re-reading pi is contained below.

**Goal:** Port the seven highest-value design ideas from pi into VEEPEE Code, ranked by value-to-effort ratio. Stay aggressively local-first; do not adopt pi's cloud-provider posture or its anti-MCP / anti-subagent stance.

**Prerequisites:** Familiarity with vcode's existing architecture — see `docs/architecture.md`, the memory files at `~/.claude/projects/-home-vp-Dev/memory/veepee-code-project.md` and `~/.claude/projects/-home-vp-Dev/memory/vcode-features-shipped.md`, and the modules touched here: `src/sessions.ts`, `src/projects.ts`, `src/agent.ts`, `src/context.ts`, `src/tui/reducer.ts`, `src/tui/components/InputBox.tsx`, `src/tui/keybindings.ts`, `src/skills.ts`, `src/user-commands.ts`, `src/config.ts`, `src/update.ts`.

---

## Table of Contents

1. [Context and motivation](#context-and-motivation)
2. [What pi does that we want — at a glance](#what-pi-does-that-we-want--at-a-glance)
3. [What we are deliberately NOT porting](#what-we-are-deliberately-not-porting)
4. [Phase P0 — JSONL tree sessions + `/tree` navigation](#phase-p0--jsonl-tree-sessions--tree-navigation) — 2 days
5. [Phase P1 — Steering vs Follow-Up message queue](#phase-p1--steering-vs-follow-up-message-queue) — ½ day
6. [Phase P2 — Inline `!cmd` / `!!cmd` editor bash](#phase-p2--inline-cmd--cmd-editor-bash) — 2 hours
7. [Phase P3 — Cumulative file tracking + retry-on-overflow in compaction](#phase-p3--cumulative-file-tracking--retry-on-overflow-in-compaction) — ½ day
8. [Phase P4 — `vcode install <git|npm>` — package distribution](#phase-p4--vcode-install-gitnpm--package-distribution) — 1–2 days
9. [Phase P5 — `before_compact` extension hook + generic custom session entries](#phase-p5--before_compact-extension-hook--generic-custom-session-entries) — ½ day (depends on P0)
10. [Phase P6 — Polish bag](#phase-p6--polish-bag) — 1 day total
11. [Cross-references — files this plan touches](#cross-references--files-this-plan-touches)
12. [Trade-offs and risks](#trade-offs-and-risks)
13. [Open questions](#open-questions)
14. [Suggested sequencing](#suggested-sequencing)

**Total MVP effort:** ~5–6 focused sessions for P0–P3 (the high-leverage half). P4–P6 are independent and can be deferred or parallelized.

---

## Context and motivation

### What pi is

A 47k-star terminal coding agent built on a radically minimal core: only `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` ship. Plan mode, sub-agents, permission gates, MCP, todos — all explicitly absent from core, available as `examples/extensions/` you copy or `pi packages` you `pi install` from npm/git.

### Why we care

Pi's surface area overlaps heavily with vcode (TUI, sessions, slash commands, skills, prompt templates, themes, statusline, AGENTS.md, hooks-as-events) but with different distribution and a few genuinely better mechanics. Lifting the *good* parts without lifting the philosophy gets us upside without paying their cost (we keep MCP, plan mode, sub-agents, hooks — those are well-validated in vcode).

### Where pi clearly leads vcode today

- **Session model:** single JSONL file with `id/parentId` tree branching. `/tree`, `/fork`, `/clone` operate on the same file. vcode uses one JSON per session and has no in-place tree navigation.
- **Message queueing during streaming:** two-tier (steering = interrupt mid-turn, follow-up = wait for idle). vcode has a single type-ahead bucket.
- **Compaction:** cumulative file-tracking across compactions + automatic retry-on-overflow with `auto_retry_start` events. vcode compacts once and trims; if still over budget, the next turn fails.
- **Distribution:** `pi install npm:@foo/pi-tools` pulls extensions/skills/prompts/themes from a single package. vcode skills/commands are local files only — no shared distribution story.
- **Telemetry transparency:** `PI_OFFLINE` / `PI_SKIP_VERSION_CHECK` / `PI_TELEMETRY` are three independent opt-outs. vcode has one `--update` toggle and a background `git fetch` that runs unconditionally on startup.

### Where vcode leads pi (do not regress)

MCP, native subagents with fleet routing, plan mode as a hard gate, hooks (PreToolUse/PostToolUse/UserPromptSubmit/Stop/Notification), MoE engine, Ralph engine, fleet-aware benchmark suite, Remote Connect web UI, sandbox, worktree, OpenAI-compatible API server, KnowledgeState, Llama Rider remote bridge, LSP integration, doctor, extras/Mason-style language bundles. All of these stay.

---

## What pi does that we want — at a glance

| Pi feature | Pi location | vcode today | Phase |
|---|---|---|---|
| JSONL session w/ `id/parentId` tree | `src/core/session-manager.ts`, `docs/session-format.md` | flat JSON per session, copy-on-fork | P0 |
| `/tree` in-place navigation, `/clone` | interactive mode, see `docs/sessions.md` | `--fork` only | P0 |
| Tree filter cycling (Ctrl+O), Shift+L bookmarks | interactive tree picker | none | P0 |
| Steering vs Follow-Up queue | `src/modes/interactive/queue.ts` (approx) | single `queuedInput` reducer slot | P1 |
| `!cmd` (run + send), `!!cmd` (run silent) | InputBox parser | `/shell` mode only | P2 |
| Cumulative `readFiles[]` / `modifiedFiles[]` on `CompactionEntry` | compaction module | none — KS regex-extracts decisions only | P3 |
| Auto-retry-on-overflow during compaction | `auto_retry_start` / `auto_retry_end` events | none — fails next turn | P3 |
| `pi install npm:foo` / `pi install git:url@v1` | `src/packages/installer.ts` (approx) | none | P4 |
| `before_compact` extension hook | extension event registry | hardcoded `compact()` | P5 |
| Custom session entry type (extension state) | typed entries in JSONL | none | P5 |
| Hot-reload themes | theme watcher | restart required | P6 |
| `AGENTS.md` alongside `CLAUDE.md`/`VEEPEE.md` | context loader | only `VEEPEE.md` walked | P6 |
| `PI_OFFLINE` / `PI_TELEMETRY` env vars | startup flow | only `--update` flag | P6 |
| Async extension factory await before agent start | extension runner | best-effort, races with first turn | P6 |
| `--system-prompt` / `--append-system-prompt` flags | CLI args | none | P6 |
| `--no-tools` / `--no-builtin-tools` allowlist flags | CLI args | none | P6 |

---

## What we are deliberately NOT porting

| Pi choice | Reason we skip |
|---|---|
| "No MCP" | vcode has it shipped, namespaced (`mcp__<server>__<tool>`), with stdio + SSE. Pi's stance only works because they have a packages ecosystem; ripping ours out is a regression. |
| "No sub-agents" | `task` tool with fleet routing is one of vcode's differentiators. Stay. |
| "No plan mode" | vcode plan mode is a hard gate (mutating tools blocked until `exit_plan_mode` approved). Core to its safety story. Stay. |
| "No hooks" | PreToolUse/PostToolUse/UserPromptSubmit/Stop/Notification are documented and depended on. Stay. |
| OAuth subscription auth (Claude Pro / ChatGPT Plus / Copilot) | vcode is intentionally Ollama-fleet-only. Cloud provider auth contradicts that constraint. |
| HuggingFace session sharing / `pi-share-hf` | Uploading code-edit sessions for "model improvement" is a privacy hazard for a personal homelab tool. Skip. |
| `/share` → public GitHub gist export | Same — too easy to leak. If we ever want this, gate behind explicit allow-list of session IDs and require a flag. |
| Pi's "no built-in todos" stance | vcode TodoWrite is wired into the agent loop and used by skills. Stay. |

---

## Phase P0 — JSONL tree sessions + `/tree` navigation

**Status:** SHIPPED 2026-05-10 (v1 — see receipts below for what's deferred). Foundational — unlocks P5 and the bookmark/filter UX.
**Effort:** ~½ day in practice (single session).
**Dependencies:** none.

### Receipts (2026-05-10)

- `src/sessions/jsonl.ts` — full `JsonlSession` primitive (create/open/append/setLeaf/fork/clone/label/updateMeta/getActivePath/getMessages/getLabelsOnPath/search/unlink). Active leaf tracked in sidecar `<id>.leaf`.
- Entry types: `meta`, `message`, `compaction`, `label`, `model_change`, `mode_change`, `custom`. Compaction summaries inject as system message replacing pre-summary entries on the active path.
- `useJsonlSessions: false` config flag (default off — opt-in until dogfooded).
- `src/sessions.ts` — dual-format save/load/list. `saveSession({ jsonl: true })` does diff-and-append (idempotent). `loadSession` and `listSessions` auto-detect by extension. `loadJsonlSession(id)` exposed for direct manipulation.
- `src/sync.ts` — pushes/pulls `.jsonl` + `.leaf` files; mtime-based conflict for non-JSON.
- `src/context.ts` — gained `replaceMessages()` for /tree rewinds.
- `/tree`, `/tree <index>`, `/clone [name]`, `/label <name>` slash commands. `/save`, `/rename`, `/fork` all honor the config flag.
- 25 new tests across `test/sessions-jsonl.test.ts` (17) and `test/sessions-jsonl-integration.test.ts` (8). Full suite: 509 passing.

### Deferrals — all SHIPPED 2026-05-10

Second pass closed the v1 deferrals:

- ✅ **Pi-style picker UI** — `src/tui/components/TreeView.tsx`. Arrow nav (↑↓/jk), Enter rewind, Esc/q cancel, Ctrl+O cycles filter modes (`default → user-only → labeled-only → all`), Shift+L opens inline label-name input, PgUp/PgDn page nav, Home/End jump. New reducer state (`treeViewActive`, `treeViewItems`, `treeViewIndex`, `treeViewFilter`, `treeViewLabelInput`) plus actions. Public TUI API: `showTreeView(items)` returns `Promise<{action: 'rewind'|'label', ...} | null>`. `/tree` slash command loops the picker so labeling stays in-flow.
- ✅ **Per-turn auto-append** — `autoAppendJsonlTurn()` in `sessions.ts`. Hooked after every `runTurn` in the main loop. First turn auto-creates a JSONL session (auto-named from the user message) and registers in `projects.json`. Subsequent turns diff-append the new tail. Idempotent. Skips legacy `.json` sessions silently. Best-effort — failures don't disrupt the chat.
- ✅ **Migration of legacy `.json` to `.jsonl`** — `migrateLegacySessions()` in `sessions.ts` + `/migrate-sessions` slash command. Walks SESSIONS_DIR, converts each `.json` to `.jsonl`, renames original to `.json.legacy` (preserves rollback). Idempotent — sessions already in JSONL are skipped. Reports migrated/skipped/errored counts.
- ✅ **Filter modes** — 4 modes (`default`, `user-only`, `labeled-only`, `all`) implemented in `filteredTreeItems()` shared between reducer and component. Cycle via Ctrl+O. (Skipped: `no-tools` as separate mode — vcode's `default` already filters tool-result messages so it's redundant.)

**Test additions:** 9 new tests in `test/sessions-jsonl-integration.test.ts` (auto-append: 5; migration: 3; existing rewind: 1). Total: **517 tests pass**.

### Still deferred (low priority)

- **Search-as-you-type within picker** — type alphanumerics → narrows visible items. Not implemented; users can use filter modes instead.
- **Ctrl+←/→ fold/unfold** — collapse compactions, tool batches, or label-grouped ranges. Nice-to-have for very long sessions; tree complexity not yet justified.

### Why

Pi stores sessions as a single append-only `.jsonl` file. Each line is a typed entry with `id` (uuid) and `parentId`. Branching happens by appending a new entry whose `parentId` points anywhere in the tree, not just at the leaf. `/tree` walks the DAG and lets you jump to any past message and continue from there. `/fork` copies a branch into a new file. `/clone` duplicates the current active path.

This is *much simpler* than vcode's current model (one JSON per session, copy-on-fork) and unlocks:
- "rewind to before the model's bad turn and try again" without losing the abandoned branch.
- Session bookmarks (label any entry as "the moment I made the right call").
- Custom extension state stored inline (P5 depends on this).

### What pi does

- File: `~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<uuid>.jsonl`. One file = one session = one tree.
- Entry types (all extend `SessionEntryBase = { id, parentId, timestamp, type }`):
  - `message` — user / assistant / tool-result / bash-execution / custom message
  - `compaction` — summary of older messages, with `firstKeptEntryId`, `tokensBefore`, optional `details: { readFiles, modifiedFiles }`
  - `branch_summary` — LLM-generated summary written when switching branches
  - `model_change`, `thinking_level_change` — metadata
  - `custom` — extension state, NOT in LLM context
  - `custom_message` — extension-injected message, IN LLM context
  - `label` — user bookmark on a target entry
- Context build: walk leaf → root, collect entries, replay through any `compaction` entries (summary replaces everything before `firstKeptEntryId`).
- `/tree` UI: search-as-you-type, fold/unfold with Ctrl+←/→, filter modes cycled with Ctrl+O (`default → no-tools → user-only → labeled-only → all`), Shift+L to label.

### What vcode does today

- File: `~/.veepee-code/sessions/{id}-{slug}.json` — flat JSON, full message array.
- `Session = { id, name, model, mode, cwd, messages, knowledgeState, createdAt, updatedAt, messageCount, toolCallCount }` (`src/sessions.ts`).
- `--fork <id>` creates a copy. No tree navigation. No way to revisit an earlier point in the same session.
- `~/.veepee-code/projects.json` maps cwd → sessionId for auto-resume (`src/projects.ts`).
- KnowledgeState persisted alongside as `~/.veepee-code/sessions/{sessionId}-state.md`.

### Implementation

**New module:** `src/sessions/jsonl.ts` (~300 LOC).

Entry types — match pi's shape, adapt names to vcode:

```ts
type EntryBase = { id: string; parentId: string | null; ts: number; type: string };

type MessageEntry = EntryBase & {
  type: 'message';
  role: 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;        // for role:'tool'
  excludeFromContext?: boolean; // for !!cmd
};

type CompactionEntry = EntryBase & {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: { readFiles: string[]; modifiedFiles: string[] };
};

type ModelChangeEntry  = EntryBase & { type: 'model_change'; from: string; to: string };
type ModeChangeEntry   = EntryBase & { type: 'mode_change'; from: Mode; to: Mode };
type LabelEntry        = EntryBase & { type: 'label'; targetId: string; name: string };
type KnowledgeEntry    = EntryBase & { type: 'knowledge'; state: KnowledgeStateData };
type CustomEntry       = EntryBase & { type: 'custom'; namespace: string; data: unknown };
type CustomMessageEntry= EntryBase & { type: 'custom_message'; role: 'user' | 'assistant'; content: string; sourceExtension?: string };

export type SessionEntry = MessageEntry | CompactionEntry | ModelChangeEntry
  | ModeChangeEntry | LabelEntry | KnowledgeEntry | CustomEntry | CustomMessageEntry;
```

Public API:

```ts
class JsonlSession {
  static open(path: string): Promise<JsonlSession>;
  static create(path: string, meta: SessionMeta): JsonlSession;

  append(entry: Omit<SessionEntry, 'id'|'ts'>): SessionEntry;  // sets parentId = currentLeafId
  setLeaf(entryId: string): void;                              // /tree navigation
  fork(targetEntryId: string, newPath: string): JsonlSession;  // copy ancestry to new file
  clone(newPath: string): JsonlSession;                        // copy current active path
  bookmark(targetEntryId: string, name: string): LabelEntry;

  getActivePath(): SessionEntry[];          // leaf → root, reversed
  getMessages(): ChatMessage[];              // resolve compactions, return LLM-ready
  getTree(): TreeNode;                       // for /tree UI
  search(predicate: (e: SessionEntry) => boolean): SessionEntry[];
}
```

**Migration:** `src/sessions.ts` keeps its existing public surface (loadSession / saveSession / listSessions / findSession). Internally it switches to JsonlSession; on first read of a legacy `.json` file, convert in-place to `.jsonl` and back up the old file to `<id>.json.legacy`.

**KnowledgeState:** instead of `{sessionId}-state.md`, write a `KnowledgeEntry` after each turn the KS changes. Keep the markdown export for human reading via a `vcode session export <id>` command.

**Active leaf:** stored as the last line of the file plus a sidecar `~/.veepee-code/sessions/{id}.leaf` (1 line, the active leaf id). Allows `/tree` to switch leaves without rewriting the JSONL.

**TUI:** new `src/tui/components/TreeView.tsx`. Reuses `WorkspaceSearch.tsx` patterns for filtering. Bound to `/tree` slash command and to Escape-Escape (matching pi).

**Slash commands:**
- `/tree` — open the tree picker.
- `/fork` — pick an entry, copy ancestry to a new session.
- `/clone` — duplicate the active branch (no picker, no choosing — just dup).
- `/name <name>` — set display name (replaces `/rename`, alias the old name).
- `/label` — bookmark the current leaf (or pass an id).

### Acceptance criteria

- [ ] All existing sessions auto-migrate on next read; no data loss.
- [ ] `/tree` opens, shows the full DAG, search works, filter cycle (`default → no-tools → user-only → labeled-only → all`) works on Ctrl+O, Shift+L labels.
- [ ] Selecting a past entry in `/tree` and pressing Enter rewinds to that point — next turn appends with `parentId = selectedId`, the abandoned branch survives in the file.
- [ ] `/fork` creates a new session file with copied ancestry.
- [ ] `/clone` creates a new session file with the current active path duplicated.
- [ ] `projects.json` auto-resume still works.
- [ ] Sync (WebDAV) still pushes/pulls correctly with the new format — JSONL is line-based so partial sync is fine; conflict resolution still uses `updatedAt`.
- [ ] 8+ unit tests in `test/sessions-jsonl.test.ts` covering: append, branch (parentId off-leaf), fork, clone, compaction roundtrip, label, custom entry, leaf rewind.

### Risks

- KnowledgeState storage change might break `compact()` — handle in P3.
- RC web UI replays from message history — needs to know about JSONL format (`src/rc.ts`). Add a thin adapter that returns the active path.
- Sandbox cleanup uses session id; unaffected.
- Langfuse observability per turn keys off `sessionId`; unaffected.

---

## Phase P1 — Steering vs Follow-Up message queue

**Status:** SHIPPED 2026-05-10.
**Effort:** ~½ day (single session).
**Dependencies:** none.

### Receipts (2026-05-10)

- `pendingMessages: { steering: string[]; followUp: string[] }` added to AppState.
- Reducer cases: `QUEUE_STEERING`, `QUEUE_FOLLOWUP`, `POP_PENDING_TO_INPUT`, `CLEAR_PENDING`, `DRAIN_STEERING`, `DRAIN_FOLLOWUP`.
- TUI handlers (during streaming): Enter → steering; Alt+Enter → follow-up; Alt+Up → pop most recent back to typing buffer; Esc → abort + restore queued to buffer; Shift+Enter still inserts newline.
- Public TUI API: `takeSteering()`, `takeFollowUp()`, `peekPending()`, `queueFollowUp()`.
- `Agent.run()` gained `onTurnBoundary` option — host callback fires between tool batches and the next LLM call; returned strings are added as user messages with a `[USER STEERING]` marker.
- `index.ts` main loop: passes `() => tui.takeSteering()` to agent, drains follow-up queue one-at-a-time before each `getInput()`.
- `InputBox.tsx` renders a panel above the editor showing queued items in sky blue (steering) and sage green (follow-up). `Conversation.tsx` adjusts `inputBoxHeight` for panel rows.
- 12 new tests in `test/pending-messages.test.ts`.

### Why

Today vcode has type-ahead during streaming — keystrokes go into `queuedInput` reducer slot and flush on the next prompt. Pi distinguishes two semantics:

- **Steering (Enter):** delivered after the current assistant turn finishes its tool calls, *before* the next LLM call. Interrupts the plan mid-turn. Use for "wait, not that file".
- **Follow-up (Alt+Enter):** delivered only after the agent is fully idle (no pending tool calls or steering). Use for "and after that, also do X".

Both queues survive Ctrl+C abort instead of being silently dropped. Both render above the editor as visible "pending" lozenges so you remember what you queued.

### What vcode does today

- `src/tui/reducer.ts` has a single `queuedInput: string` slot.
- On `getInput()` the queued text is moved into the active input — there is no notion of *when* in the agent's lifecycle to deliver it.
- Ctrl+C aborts the chat (`AbortController` in `src/agent.ts`) and any queued text on the editor line survives — but if the user had queued multiple messages that's not modeled.

### Implementation

**Reducer:** replace `queuedInput: string` with `pendingMessages: { steering: string[]; followUp: string[] }`.

**Keybindings (`src/tui/keybindings.ts`):**
- `Enter` while streaming → `dispatch({ type: 'queue_steering', text })`. Behavior when not streaming is unchanged (submit immediately).
- `Alt+Enter` while streaming → `dispatch({ type: 'queue_followup', text })`. When not streaming, fallback to multi-line Shift+Enter behavior so we don't lose that.
- `Alt+Up` → pop most recent queued message back into the editor for editing (matches pi).
- `Escape` while streaming → abort + restore queued messages to the editor (matches pi).

**Agent loop (`src/agent.ts`):** Agent already has clear turn boundaries (yields `done` event after each LLM round-trip). Add two delivery points:
- After each `tool_result` batch, before the next LLM call, drain steering queue: prepend `{role: 'user', content: msg}` for each.
- After `done` with no further tool calls (turn fully idle), drain follow-up queue.

**TUI (`src/tui/components/InputBox.tsx`):** render a small panel above the editor showing both queues:

```
↪ steering: "use the test file in fixtures/"
↪ follow-up: "then run npm test", "then commit"
```

with subtle coloring (sky blue for steering, sage green for follow-up — matching the existing theme palette).

**Persistence:** queued messages are TUI state only. They do *not* land on disk and do *not* survive process restart. (Pi same.) If user wants a queued message preserved, they cancel and re-type.

### Acceptance criteria

- [ ] Enter during streaming queues steering, Alt+Enter queues follow-up, both visible above editor.
- [ ] Steering delivered between tool-result and next LLM call, never mid-tool.
- [ ] Follow-up delivered only when agent fully idle.
- [ ] Ctrl+C aborts current turn but preserves both queues; Escape aborts and *restores* queued messages to the editor (so they can be edited or discarded).
- [ ] Alt+Up pops most-recent queued message back into editor.
- [ ] 4 unit tests in `test/tui-queue.test.ts` covering reducer transitions and abort behavior.

### Risks

- Plan mode interaction: in plan mode the agent already pauses for `exit_plan_mode` approval. Steering should still work — it's just another user message in the queue. Follow-up is meaningless in plan mode (no idle state until exit). Document this; don't special-case.
- MoE / Ralph engines: they have their own turn structure. For v1, steering/follow-up is only wired in the standard Agent loop. Document and skip MoE/Ralph in this phase.

---

## Phase P2 — Inline `!cmd` / `!!cmd` editor bash

**Status:** SHIPPED 2026-05-10.
**Effort:** ~1 hour (single session).
**Dependencies:** none.

### Receipts (2026-05-10)

- New module `src/inline-bash.ts`: `parseBang`, `runInlineShell`, `formatShellForLlm`, `truncateOutput`. Output capped at 8 KiB / 200 lines.
- Wired into `index.ts` main loop *after* `runTurn` is defined so the `!cmd` path can call it. Old single-bang silent-shell-escape replaced by the dual-prefix logic.
- `!cmd` runs, shows output in chat, AND forwards captured output to the LLM as the next turn's user message (wrapped in `[shell] $ cmd / output / [/shell]`).
- `!!cmd` runs, shows output, does NOT forward to LLM (matches the prior behavior of single-bang).
- `! cmd` (with whitespace after the bang) is treated as prose — no shell escape.
- 18 tests in `test/inline-bash.test.ts`.

### Why

Daily-use friction: you want to peek at a file or check `git status` mid-conversation. Today `/shell` switches modes; pi just lets you type `!ls src/` in the editor.

- `!cmd` runs the command, shows output in the messages area, *and sends the output to the LLM as a user message* (so the model sees it next turn).
- `!!cmd` runs the command and shows output but *does not* send to LLM.

Trivial implementation, high daily-use value.

### What vcode does today

- `/shell <cmd>` slash command runs a single bash command, output dumped to messages.
- `/sh` alias.
- No way to attach output to the next user message.

### Implementation

**Editor parser (`src/tui/components/InputBox.tsx`):** when submitted text starts with `!` (and is not `!!`):
1. Strip the leading `!`, run via existing bash executor with the same permissions / sandbox checks.
2. Render output as a system-style message in the conversation.
3. Append the output to the next user message as a quoted block:

```
[shell] $ git status
On branch main
nothing to commit
[/shell]
```

When submitted text starts with `!!`:
1. Strip the leading `!!`, run.
2. Render output as a system-style message with an "(excluded from context)" marker.
3. Do *not* attach to next user message. The corresponding session entry gets `excludeFromContext: true` (matches pi).

**Permission flow:** unchanged — bash permission rules from `permissions.ts` apply to `!cmd` exactly as they do to the `bash` tool. `!!cmd` is in the same boat: it still asks for permission, it just doesn't ship the result to the LLM.

**Slash command coexistence:** if the user types `! ls` (with space) — that's not `!cmd`. Require no space after `!`. Otherwise `! ` is reserved for nothing useful and we should leave it alone.

### Acceptance criteria

- [ ] `!ls src/` runs ls, shows output, output appears in next LLM call.
- [ ] `!!ls src/` runs ls, shows output, does NOT appear in LLM call.
- [ ] Permissions enforced identically to the `bash` tool.
- [ ] Disabled in plan mode (matches the existing plan-gate).
- [ ] Disabled in chat mode (no shell access from `CHAT_TOOLS`).
- [ ] 2 unit tests in `test/inline-bash.test.ts`.

### Risks

- Output truncation: cap at 8 KB / 200 lines per pi's defaults. Honor existing tool-output truncation rules already used by the `bash` tool.

---

## Phase P3 — Cumulative file tracking + retry-on-overflow in compaction

**Status:** SHIPPED 2026-05-10.
**Effort:** ~1 hour (single session).
**Dependencies:** P0 was nominally a dependency for `CompactionEntry.details`, but the in-memory ledger was implemented directly on `ContextManager` and is independent of the JSONL session. P0's storage hooks remain available for future persistence.

### Receipts (2026-05-10)

- `ContextManager.compactedReadFiles` / `compactedModifiedFiles` (private string[] arrays, capped at `MAX_LEDGER_ENTRIES = 200` with FIFO eviction).
- `mergeIntoFileLedger(messages)` — walks tool calls in dropped messages, extracts `read_file`/`glob`/`grep`/`list_files` paths into reads, `write_file`/`edit_file`/`multi_edit`/`notebook_edit` paths into modified. Modified takes precedence (a file appearing in both is dropped from reads).
- Both `compact()` and `compactAsync()` call `mergeIntoFileLedger` before pruning.
- `getSystemPrompt()` appends a "Files touched in earlier turns (compacted from context)" section when the ledger is non-empty. Lists are capped at 50 visible entries with `… and N more` tail when longer.
- `getCompactedFileLedger()` / `setCompactedFileLedger()` exposed for external persistence (e.g. round-tripping through JSONL `CompactionEntry.details` after `/tree` rewinds).
- `replaceMessages()` clears the ledger (rewind invalidates the abandoned branch's accumulation).
- `compactWithRetry()` wraps `compactAsync` with a retry loop: if projected tokens still exceed `contextLimit * 0.85` after compaction, calls `dropAggressive()` (keep summary + last 4 messages only) and re-projects. Capped at 3 attempts. Calls `onRetry(attempt, projected, limit)` so the caller can yield events.
- `agent.ts` updated at both compaction trigger points (initial check + post-tool-results) to use `compactWithRetry`. Yields a "Compacted conversation" thinking event, plus one "Compacting harder (attempt N) — projected X > Y cutoff" thinking event per retry.
- 10 new tests in `test/compaction-ledger.test.ts`: ledger merging, modified-precedence, system-prompt rendering, replaceMessages clears, accumulation across compactions, FIFO cap at 200, retry triggers when overflow, retry caps at maxAttempts, retry no-ops when initial fits.
- Total tests: **517 → 527 passing**.

### Why

Two distinct gaps, both papered over by pi:

1. **Cumulative file ledger.** Pi's `CompactionEntry.details = { readFiles, modifiedFiles }` lists every file touched in the messages being compacted away. Crucially: each new compaction *merges* the previous compaction's lists in. So even after 5 rounds of compaction, you still know every file touched in this session. vcode's KnowledgeState has `filesRead[]` / `filesModified[]` but they get pruned with the messages.

2. **Retry on overflow.** Pi compacts, then checks: `summary.tokens + keptMessages.tokens > contextWindow` → emits `auto_retry_start`, waits 1s, re-runs with smaller `keepRecentTokens`. vcode's `compact()` runs once; if it's still over budget the next turn fails or silently drops messages.

### What vcode does today

- `src/context.ts compact()` (line ~ depending on current state) drops middle messages, calls Ollama with the dropped messages asking for KS refresh, parses key-value pairs, merges into KS.
- No file-touch ledger in the snapshot.
- No retry — if the post-compaction window still overflows, the next `getMessages()` call breaks at the model's context limit.
- KS extracts `filesRead` / `filesModified` from tool calls but ages them out.

### Implementation

**A) File ledger.**

In `src/context.ts compact()`:
1. Before pruning, scan the messages-to-be-dropped for tool calls. Extract:
   - `read_file`, `glob` (when single file), `grep` with explicit path → into `readFiles`.
   - `write_file`, `edit_file` → into `modifiedFiles`.
2. Merge with previous `compaction` entry's `details` (if any) by reading the most recent CompactionEntry from the JSONL session.
3. Store on the new CompactionEntry as `details: { readFiles, modifiedFiles }`.

When building the system prompt, if we have a recent CompactionEntry with `details`, render a section:

```markdown
## Files touched earlier (compacted from context)

Read: src/agent.ts, src/context.ts, test/agent.test.ts
Modified: src/agent.ts, src/context.ts
```

This means even after compaction the model knows what's been touched and won't redundantly re-read them.

**B) Retry on overflow.**

Wrap `compact()` in a loop:

```ts
async function compactWithRetry(state: ContextState, opts: CompactOpts) {
  let keepRecent = opts.keepRecentTokens ?? DEFAULT_KEEP_RECENT;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await compact(state, { keepRecentTokens: keepRecent });
    const projected = estimateTokens(result.messages) + estimateTokens(result.summary);
    if (projected <= contextLimit * 0.85) return result;
    yield { type: 'auto_retry_start', attempt: attempt + 1, projected, limit: contextLimit };
    await sleep(1000);
    keepRecent = Math.floor(keepRecent * 0.6);
  }
  yield { type: 'auto_retry_end', success: false };
  throw new ContextOverflowError(...);
}
```

Yield `auto_retry_start` / `auto_retry_end` events through the agent's event stream so TUI can render a "compacting harder…" notice instead of going silent.

### Acceptance criteria

- [ ] After a compaction, `details.readFiles` and `details.modifiedFiles` reflect the dropped messages' tool calls.
- [ ] Subsequent compactions merge previous `details` (test: two synthetic compactions, second's `readFiles` is a superset).
- [ ] System prompt includes a "Files touched earlier" section when compactions have occurred.
- [ ] If summary + kept messages exceed 85% of context limit, `compactWithRetry` shrinks `keepRecentTokens` by 40% and tries again, up to 3 times.
- [ ] TUI renders a status indicator during retries.
- [ ] 4 unit tests in `test/compact-retry.test.ts`.

### Risks

- The ledger can grow unbounded over very long sessions. Cap at 200 entries per list (LRU), oldest dropped first, with a `… and N more` line in the system prompt.
- Mutual exclusion: don't double-count if a file appears in both reads and writes — write supersedes read in the ledger.

---

## Phase P4 — `vcode install <git|npm>` — package distribution

**Status:** OPEN.
**Effort:** ~1–2 days.
**Dependencies:** none. Builds on existing `src/skills.ts` and `src/user-commands.ts`.

### Why

Vcode skills, user slash commands, and (eventually) themes / output-styles are local files. There's no shared distribution. Pi's `pi install npm:@foo/pi-tools` / `pi install git:github.com/user/repo@v1` is a clean MVP for sharing — it pulls a directory tree, looks for known sub-folders (`skills/`, `commands/`, `output-styles/`, `themes/`), and registers them.

This also unlocks: "install the official vcode-recipes pack from github.com/vpontual/vcode-recipes" for the user's own bundles.

### What pi does

- `pi install npm:@foo/pi-tools[@1.2.3]` — npm-resolves into `~/.pi/agent/git/<name>/`.
- `pi install git:github.com/user/repo[@v1]` — git-clones into `~/.pi/agent/git/<name>/`.
- `pi install -l <source>` — project-local at `.pi/git/`.
- Reads `package.json` `pi` key:
  ```json
  { "pi": { "extensions": ["./extensions"], "skills": ["./skills"],
            "prompts": ["./prompts"], "themes": ["./themes"] } }
  ```
- Falls back to auto-discovery from conventional dirs if no manifest.
- `pi list` / `pi remove` / `pi update` / `pi config` (enable/disable individual resources).

### What we ship for v1

Drop "extensions" since vcode doesn't have an extension system (P5 lays the groundwork for a *limited* one). Cover four resource types:

| Type | Existing loader | Source dir conv |
|---|---|---|
| Skills | `src/skills.ts` | `skills/` |
| User slash commands | `src/user-commands.ts` | `commands/` |
| Output styles | `src/output-styles.ts` | `output-styles/` |
| Themes (future) | n/a yet | `themes/` |

Manifest in `package.json`:

```json
{
  "name": "vcode-recipes-vp",
  "keywords": ["vcode-package"],
  "vcode": {
    "skills": ["./skills"],
    "commands": ["./commands"],
    "output-styles": ["./output-styles"]
  }
}
```

### Implementation

**New module:** `src/packages.ts` (~250 LOC).

```ts
export async function install(spec: string, opts?: { local?: boolean }): Promise<InstallResult>;
export async function remove(name: string, opts?: { local?: boolean }): Promise<void>;
export async function list(): Promise<InstalledPackage[]>;
export async function update(name?: string): Promise<void>;
```

**Spec parser:** `npm:<name>[@version]`, `git:<url>[@ref]`, `https://github.com/...[@ref]`, `ssh://git@github.com/...[@ref]`. Match pi's syntax exactly so docs / muscle memory transfer.

**Install location:** `~/.veepee-code/packages/<name>/` (global) or `.veepee/packages/<name>/` (project, with `-l`).

**Resource discovery:**
1. Look for `package.json` `vcode` key. Use declared paths.
2. Fallback: auto-discover `skills/`, `commands/`, `output-styles/`, `themes/` directories under the package root.
3. Register with the existing loaders (`skills.ts`, `user-commands.ts`, `output-styles.ts`).

**Loader changes:** all three loaders today walk fixed paths (`~/.veepee-code/<dir>/`, `.veepee/<dir>/`). Add `~/.veepee-code/packages/*/<dir>/` and `.veepee/packages/*/<dir>/` to the search.

**Slash commands:**
- `/install <spec>` — install a package.
- `/uninstall <name>` — remove.
- `/packages` — list installed.
- `/packages update [name]` — update one or all.

**CLI flags:**
- `vcode install <spec>` — install from CLI without entering TUI.
- `vcode list` — list installed.
- `vcode update --packages` — update all.

**Security:** packages run with full system access (skills can include shell commands the model executes). `/install` shows a confirmation prompt with the package URL and a "review the README first" reminder. Match pi's warning copy.

### Acceptance criteria

- [ ] `vcode install git:github.com/vpontual/vcode-recipes` clones, discovers resources, registers them.
- [ ] `/skills` lists newly-installed skills with a `[from: vcode-recipes]` tag.
- [ ] `/uninstall vcode-recipes` removes the directory and unregisters resources.
- [ ] `/packages update` re-pulls all installed packages.
- [ ] Project-local install with `-l` works and resources only register when in that project.
- [ ] 5 unit tests in `test/packages.test.ts` (spec parsing, install dry-run, manifest discovery, fallback discovery, list/remove).

### Risks

- npm packages can have native deps; for v1 we restrict to git installs and document that npm support is "no-build, source-only" (we don't run `npm install` — packages must vendor their content). This keeps installs fast and side-effect-free.
- Update can leave orphan resource entries in memory if a skill was renamed; handle via "unregister all resources from this package, re-discover" on update.

---

## Phase P5 — `before_compact` extension hook + generic custom session entries

**Status:** OPEN.
**Effort:** ~½ day.
**Dependencies:** P0 (needs the JSONL `custom` entry type).

### Why

Two pieces:

1. **`before_compact` hook.** Pi's compaction is overridable: an extension can listen for `session_before_compact`, modify the summary template, add custom `details` fields, or block. Vcode's compaction is hardcoded.
2. **`custom` session entry type.** Lets future plan-mode / MoE / Ralph engines persist their own state inline in the session JSONL without polluting the LLM context.

These are infrastructure for *eventually* growing an extension story without committing to one now.

### What pi does

- Extension API exposes typed events: `session_start`, `session_shutdown`, `before_agent_start`, `tool_call`, `tool_result`, `before_compact`, `queue_update`, etc.
- Handlers receive `(event, ctx)` where `ctx` provides `ui`, `sessionManager`, `model`, `signal` (abort).
- Return values control flow: `{ block: true, reason }` aborts, `{ override: ... }` substitutes.
- `pi.appendEntry({ type: 'custom', namespace: 'plan-mode', data: {...} })` writes to the JSONL.

### What we ship for v1

Vcode doesn't have an extension *runtime* (and we don't need one yet — packages from P4 are static markdown). What we ship:

**A) Compaction hook surface.**

In `src/context.ts compactWithRetry()`, before invoking the LLM, fire a hook:

```ts
const customized = await hooks.fire('BeforeCompact', {
  messages: messagesToDrop,
  knowledgeState: state.ks,
  proposedSummary: defaultSummaryTemplate,
});
// hook output may include: { summary?: string, details?: Record<string, unknown>, block?: { reason: string } }
```

This piggybacks on the existing `src/hooks.ts` infrastructure (PreToolUse / PostToolUse / etc.). Add `BeforeCompact` to `HookType`.

**B) `vcode_session_entry` writer for hook scripts.**

Hook scripts (today they're shell commands in settings.json) get a new env var: `VCODE_SESSION_FILE`. They can append a custom entry by writing JSON to that file. We document the format in `docs/hooks.md`.

For models / future extensions that want to persist state mid-turn, the agent loop exposes a tiny meta-tool (gated behind a settings flag, off by default):

```ts
session_append({ namespace: string, data: unknown }) -> { id: string }
```

This is *not* a normal tool — it's behind `experimental.sessionAppend: true` in settings.json and won't appear in `/tools` unless enabled. Keeps the surface minimal until we have a real use case.

### Acceptance criteria

- [ ] `BeforeCompact` hook fires before each compaction, can replace the summary, can add `details` fields, can block.
- [ ] Hook output `{ block: { reason } }` skips compaction for this turn (logged, retried next turn).
- [ ] Custom entries written via `VCODE_SESSION_FILE` survive across `/tree` rewinds (they're entries on the active path, not in-context).
- [ ] `experimental.sessionAppend` defaults false; when true, model can call `session_append`.
- [ ] 3 unit tests in `test/before-compact-hook.test.ts`.

### Risks

- The hook running on every compaction adds latency; make it best-effort with a 5s timeout per pi's pattern.
- `session_append` from the model is a footgun if we let it bypass permissions. Lock to namespaces declared in settings.json (`experimental.sessionAppendNamespaces: ["plan-mode", "ralph"]`).

---

## Phase P6 — Polish bag

**Status:** OPEN.
**Effort:** ~1 day total, items independent. Order doesn't matter.

These are individually small but each one removes a real daily friction.

### P6.1 — Hot-reload themes (~1 hour)

Today: theme is a static palette in `src/tui/theme.ts`. Changing colors requires a rebuild.

Pi: themes are JSON files; `chokidar`-style watcher reloads on file change.

**Implementation:** add `~/.veepee-code/themes/` and `.veepee/themes/`, JSON format `{ name, colors: { primary, accent, success, error, warning, userBg } }`. On file change, dispatch a reducer action that swaps the active theme. No restart.

### P6.2 — `AGENTS.md` alongside `VEEPEE.md` (~1 hour)

Today: `src/context.ts` walks up looking for `VEEPEE.md`. Pi reads both `AGENTS.md` and `CLAUDE.md`; the convention is gaining traction (codex, cursor, others).

**Implementation:** in `loadProjectContext()`, walk for `AGENTS.md` and `VEEPEE.md` in each ancestor directory; concat both with source annotations. `CLAUDE.md` stays out — that's the user's auto-memory file and we don't mess with it.

### P6.3 — Telemetry / update opt-out env vars (~½ hour)

Today: `src/update.ts` does an unconditional `git fetch` on startup; only `--update` toggles the actual update.

Pi splits into three env knobs:
- `PI_OFFLINE` — disable all startup network ops.
- `PI_SKIP_VERSION_CHECK` — disable just the version check.
- `PI_TELEMETRY=0` — disable install/update reporting (we don't have any, but we should reserve the var).

**Implementation:** add `VCODE_OFFLINE`, `VCODE_SKIP_VERSION_CHECK` env vars. `VCODE_OFFLINE` short-circuits `checkForUpdate()` and any future network calls (sync push/pull stays under user control via `/sync`).

### P6.4 — `--system-prompt` / `--append-system-prompt` flags (~½ hour)

Today: replacing the system prompt requires editing `src/context.ts`.

Pi: `--system-prompt "..."` replaces it (skills + context files still appended); `--append-system-prompt "..."` appends.

**Implementation:** thread two new args through `src/index.ts → context.ts buildSystemPrompt()`. When `--system-prompt` is set, skip the templated default but still append `{{LLAMA_MD}}` and skill index. When `--append-system-prompt`, append after everything else.

### P6.5 — `--no-tools` / `--no-builtin-tools` (~½ hour)

Today: `--tools <list>` doesn't exist; the agent always has the full registry.

Pi:
- `--tools read,grep,find,ls -p "review the code"` — allowlist exact tools.
- `--no-builtin-tools` — disable built-ins, keep MCP / remote tools.
- `--no-tools` — disable everything.

**Implementation:** add the three flags to `src/cli/args.ts`. Pass through to Agent constructor as `allowedToolNames: Set<string> | null`. Apply at registry-filter time, same as the API server already does for `tools` in chat completion requests.

### P6.6 — Async extension factory await (~½ hour)

Today: MCP discovery (`src/mcp.ts`) launches in the background; the agent might start its first turn before MCP tools are registered.

Pi: extension factories can be async, and `pi` waits for them before starting.

**Implementation:** in `src/index.ts main()`, `await Promise.all([loadMcp(), loadSkills(), loadUserCommands(), loadOutputStyles()])` before constructing `Agent`. Currently some of these are fire-and-forget. Add a 10-second cap with a warning log if any takes longer.

### P6.7 — Tree-view filter cycle + bookmarks (folded into P0)

These were originally separate but they only make sense once P0 is in. Listed here for cross-reference: Ctrl+O on the tree picker cycles `default → no-tools → user-only → labeled-only → all`; Shift+L bookmarks the current entry.

### Acceptance criteria

- [ ] Each sub-item has at least 1 unit test or documented manual verification.
- [ ] `npm run check:polish` adds checks for #1, #2, #5 to prevent regression.

---

## Cross-references — files this plan touches

| File | Phases | Nature of change |
|---|---|---|
| `src/sessions.ts` | P0 | Refactor internals to JsonlSession; keep public API |
| `src/sessions/jsonl.ts` | P0 | NEW — core JSONL session logic |
| `src/projects.ts` | P0 | Update to handle `.jsonl` extension |
| `src/sync.ts` | P0 | Adapt to push/pull `.jsonl` (line-based diff would be a nice-to-have, not required) |
| `src/rc.ts` | P0 | Replay-from-history needs to walk active path |
| `src/tui/components/TreeView.tsx` | P0 | NEW — `/tree` UI |
| `src/tui/reducer.ts` | P0, P1 | Tree state, dual-queue state |
| `src/tui/keybindings.ts` | P0, P1 | `/tree` bindings, Alt+Enter, Alt+Up, Ctrl+O |
| `src/tui/components/InputBox.tsx` | P1, P2 | Pending-message panel; `!cmd` / `!!cmd` parser |
| `src/agent.ts` | P1 | Steering / follow-up delivery points |
| `src/context.ts` | P3, P5 | `compactWithRetry`, file ledger, `BeforeCompact` hook |
| `src/hooks.ts` | P5 | Add `BeforeCompact` hook type |
| `src/packages.ts` | P4 | NEW — package install/remove/list/update |
| `src/skills.ts`, `src/user-commands.ts`, `src/output-styles.ts` | P4 | Add package-dir search paths |
| `src/cli/args.ts` (or wherever flags parse) | P6 | New flags |
| `src/update.ts` | P6 | Honor `VCODE_OFFLINE` / `VCODE_SKIP_VERSION_CHECK` |
| `src/tui/theme.ts` | P6 | Hot-reload watcher |
| `src/index.ts` | P0, P4, P6 | Boot sequence — await MCP/skills/etc.; new flags |
| `docs/architecture.md` | All | Update once shipped |
| `docs/sessions.md` (NEW) | P0 | Document JSONL format |
| `docs/packages.md` (NEW) | P4 | Document install / authoring |

---

## Trade-offs and risks

### Migrating to JSONL (P0) is the riskiest single change

It touches sessions / projects / sync / rc. The blast radius justifies a careful sequencing:

1. Build `JsonlSession` next to existing `Session`. Both work.
2. Add a `useJsonlSessions` setting flag, default false.
3. Run for a week with the flag on locally; debug edge cases (sync conflicts, RC replay, KS roundtrip).
4. Flip default to true in a release; keep legacy reader for one full version.
5. Remove legacy writer next version.

### Package security (P4) must be loud

Packages can ship skills that tell the model to run arbitrary shell. We can't sandbox markdown — so the install confirmation has to be obnoxious, with the URL, the README excerpt (first 10 lines), and a "type the package name to confirm" prompt for first-time installs. Match pi's warning verbatim:

> Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

### `BeforeCompact` hook latency (P5) can stall turns

Cap at 5s. If the hook times out, log and proceed with the default compaction. Don't block on a flaky user script.

### Steering messages (P1) can confuse the model

If you steer mid-tool-call, the model might continue executing the now-irrelevant plan from before your steering message. Mitigate via the system prompt: when delivering a steering message, prepend `[USER STEERING]` and a short instruction: "The user has changed direction. Re-evaluate based on this new input before continuing."

### What if pi's mechanics turn out to be terrible in practice?

Each phase is independent and reversible. JSONL sessions can be reverted to JSON via export. Steering queue can be downgraded back to single-bucket. Inline `!cmd` is opt-in by syntax. Packages can be removed. Hooks can be ignored. Polish items are independently togglable. **Don't ship more than two phases without using vcode for a real coding session in between** — the goal is to confirm each one feels right, not just to clear the list.

---

## Open questions

1. **Q:** Does the JSONL session format break Langfuse observability (`src/observability.ts`)?
   **A:** Probably not — Langfuse keys off `sessionId` and per-turn metrics. But verify that the trace structure (`trace + generation` per turn) still works when entries are appended out of leaf order (e.g., during tree navigation).

2. **Q:** Should `/clone` create a brand-new session id or share the parent's?
   **A:** New id, but record `clonedFrom: parentSessionId` in the new session's first metadata entry. Lets us cross-link in `/sessions`.

3. **Q:** Should bookmarks (Shift+L labels) sync via WebDAV?
   **A:** Yes — they're entries in the JSONL, no special handling needed.

4. **Q:** Do we want `vcode share` (HTML export, gist upload) at all?
   **A:** Defer. Pi's value is collecting OSS sessions for model training; we don't need that. If the user wants to share a session with someone, `cat session.jsonl | gh gist create` already works.

5. **Q:** P4 packages: support npm or git-only?
   **A:** Git-only for v1. No `npm install` step (packages vendor content). Reconsider if there's actual demand.

6. **Q:** Should `before_compact` hook also fire on manual `/compact`?
   **A:** Yes — same hook, fires for both auto and manual compaction. The hook payload gets a `trigger: 'auto' | 'manual'` field.

---

## Suggested sequencing

```
P0 (2d)
├── enables P5
├── enables P6.7 (tree filter + bookmarks)
└── enables future extension state persistence

P1 (½d) — independent, ship anytime
P2 (2h) — independent, ship anytime
P3 (½d) — depends on P0
P4 (1-2d) — independent
P5 (½d) — depends on P0
P6 (1d, parallelizable) — independent
```

**Recommended order:** P2 (warm up, cheap, daily-use), then P1 (½ day, useful immediately), then P0 (the big one), then P3 and P5 (compaction quality), then P4 (when you actually want to share something), then P6 (anytime).

**If you only do half the plan:** P0 + P1 + P3 is the high-leverage subset. P2 is the cheapest quality-of-life win and worth doing first regardless.

**Trigger phrases (durable):**
- `"start pi-learnings phase 0"` — JSONL sessions
- `"start pi-learnings phase 1"` — message queue
- `"start pi-learnings phase 2"` — inline bash
- `"start pi-learnings phase 3"` — compaction quality
- `"start pi-learnings phase 4"` — packages
- `"start pi-learnings phase 5"` — hooks + custom entries
- `"start pi-learnings phase 6"` — polish bag
- `"audit vcode against pi"` — re-evaluate (pi moves fast — re-check before committing to anything)
