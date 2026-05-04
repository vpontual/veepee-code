# VEEPEE Code World-Class Parity Plan

**Status:** Phases 0-4 SHIPPED 2026-05-03 in a single working session. Phases 5-6 deferred — user paused to collect real-world friction data before continuing.
**Scope:** match and exceed Claude Code, Gemini CLI, OpenCode across user-facing functionality.
**Hard constraint:** keep local-first / Ollama-fleet differentiator. Never require a cloud provider.
**Owner:** Claude (lead engineer). PM: Vitor.

## Quick resume — for the next session

If you're picking this up cold, start here:

- **Phases 0-4 are DONE.** Detailed receipts below in each phase section. Polish-regression check has 10 checks; `npm run prebuild` runs it on every build.
- **What's left:** Phase 5 (cross-session memory) and Phase 6 (differentiator amplification). Both optional — see "What's NOT in this plan" for why pausing was the right call.
- **Trigger phrases** (durable):
  - `"begin phase 5"` → start cross-session memory work
  - `"begin phase 6"` → elevate MoE / fleet / cross-family-reviewer UX
  - `"audit vcode polish"` → run the lint + manually look for new gaps to fold into Phase 0-style cleanup
  - `"redo the parity audit"` → re-evaluate vs Claude Code's current feature set; some things may have shifted
- **Reality check before resuming Phase 5:** Phase 5 (per-cwd persistent memory) overlaps significantly with the auto-memory system Claude already provides for user. If user has been heavily relying on `update_memory` + Claude's memory across vcode sessions, Phase 5 may be redundant. Confirm need before building.

## What shipped 2026-05-03 (one-session burst)

| Phase | Features | LOC delta (rough) | Polish checks added |
|---|---|---|---|
| 0 | 11 polish fixes (P1-P11) + lint | ~150 | 3 |
| 1 | Settings hierarchy, hooks, user slash commands, diff preview | ~600 | 2 |
| 2 | MCP client (stdio+SSE), skills system, ToolSource refactor | ~700 | 2 |
| 3 | Native subagents w/ fleet routing, background, plan-mode gate, allowedModels guardrail | ~500 | 2 |
| 4 | Image input fixes, statusline shell script, output styles, notebook editing, @file tab-complete | ~600 | 2 |

Total: ~2500 LOC of net-new functionality. Codebase grew from 12,821 → roughly 15,300+ lines in `src/`.

---

## North star

> A local-first AI coding agent that matches Claude Code's polish and feature breadth, beats it on fleet-aware multi-model workflows, and treats every release as production-quality. If a feature ships, it works end-to-end, is documented in `/help`, has no dead code or false detection, and survives an audit.

---

## What's in scope vs out of scope

**In scope:** every user-facing feature Claude Code has, plus the differentiators we already lead on (local fleet, MoE, cross-family review).

**Out of scope (intentionally):**
- Cloud provider integration (we chose local Ollama).
- IDE extensions in v1 (CLI-first; revisit after parity).
- Commercial billing / auth UX.
- Anthropic-specific tooling (Files API, Batch API, etc.).

---

## Audit findings (2026-05-03 session)

### Polish issues uncovered today

| ID | Severity | Issue | Status |
|---|---|---|---|
| P1 | HIGH | `getProjectTree` 150-cap fills with `benchmarks/scratch/*/undefined` garbage | FIXED — added `'scratch'` to exclusions |
| P2 | HIGH | `detectProject` returns `framework: "React"` for vcode itself (Node CLI tool) — false-positive feeds wrong coding guidance | OPEN |
| P3 | MED | `keybindings.ts` declares `Ctrl+Up/Down → scrollUp/Down`, but real handler in `tui/index.ts:840` listens for `Shift+Up/Down`. Dead code. | OPEN |
| P4 | MED | `scrollTop` and `scrollBottom` declared in `KeyAction` union; no key bindings, no reducer cases. Orphan declarations. | OPEN |
| P5 | LOW | `useMouseScroll` hook defined but never imported (superseded by 2026-05-03 burst-disambiguation). | OPEN — delete |
| P6 | MED | Scrollback feature (Shift+Up/Down, PgUp/PgDn, trackpad) not documented in `/help` or anywhere a new user finds it. | OPEN |
| P7 | MED | Trackpad scroll silently misrouted to input history. | FIXED — burst disambiguator at `tui/index.ts:88` |
| P8 | LOW | `vcode.config.example.json` missing `remote.allow` field added 2026-05-03. | OPEN |
| P9 | LOW | `shellHistoryContext` defaults to `true` but most users won't want it. | OPEN — change default to `false` |
| P10 | LOW | Benchmark scratch generator emits files literally named `undefined` — symptom of upstream bug. | OPEN |
| P11 | MED | No crash-handler-on-startup banner like Llama Rider has (PID, version, config path). Already added handlers but no banner. | OPEN |

### Functional gaps vs Claude Code

| ID | Severity | Gap | Effort | Phase |
|---|---|---|---|---|
| F1 | CRITICAL | **No MCP support.** Industry standard for tool extensibility. | 10-14d | Phase 2 |
| F2 | CRITICAL | **No hooks system.** Claude Code's killer power-user feature. Lets users automate harness behaviors via `settings.json`. | 4-6d | Phase 1 |
| F3 | HIGH | **No user-defined slash commands.** Currently 52 hardcoded in `App.tsx:11-64`. | 2-3d | Phase 1 |
| F4 | HIGH | **No skills system.** Markdown skill files with frontmatter, lazy-loaded. Llama Rider has it. | 4-6d | Phase 2 |
| F5 | HIGH | **No native subagents.** Got `spawn_agent` via Llama Rider remote bridge today, but no first-class native Task tool. | 5-7d | Phase 3 |
| F6 | HIGH | **No diff preview before edits.** `edit_file` applies changes silently. Safety + clarity gap. | 2-3d | Phase 1 |
| F7 | HIGH | **No plan-mode gate.** Plan mode exists but no `ExitPlanMode`-style explicit user approval before exiting plan into act. | 1-2d | Phase 3 |
| F8 | MED | **No background / long-running agents.** Claude Code's `run_in_background` lets you dispatch and continue. | 4-6d | Phase 3 |
| F9 | MED | **Image input partial.** `agent.ts:188` detects image paths but no first-class drag-drop / paste / `@image.png` UX. | 3-4d | Phase 4 |
| F10 | MED | **No settings hierarchy.** Single `~/.veepee-code/vcode.config.json`. Claude Code has global → user → project → local. | 3-4d | Phase 1 |
| F11 | MED | **Cross-session memory missing.** `KnowledgeState` is session-scoped (sessionId in constructor); no persistent memory like Claude Code's auto-memory. | 3-5d | Phase 5 |
| F12 | MED | **No status line customization.** Claude Code has `statusline-setup` skill. | 2-3d | Phase 4 |
| F13 | LOW | **No output styles.** Claude Code's persona switching (terse, verbose, etc.). | 1-2d | Phase 4 |
| F14 | LOW | **No notebook editing.** `NotebookEdit` for Jupyter. Niche but expected. | 2-3d | Phase 4 |
| F15 | LOW | **No `@file` mention syntax** in input (Gemini CLI feature; auto-attach file content). | 2-3d | Phase 4 |
| F16 | LOW | **No plugin system** (Claude Code's `compound-engineering` model). Defer until Phase 6+. | 7-10d | Future |

### Strengths to preserve and amplify

These are why someone would pick vcode over Claude Code today. **Don't regress these during parity work.**

- Local-first / offline / privacy-preserving (zero outbound API calls)
- Fleet awareness: `proxyUrl` + `lockModel` + `maxModelSize`/`minModelSize` + auto-switch
- Cross-family reviewer (Qwen + Gemma critic loop)
- MoE strategies (`/moe debate`, `/moe vote`, `/moe fastest`)
- Token-budget visibility in status bar
- Replay corpus + benchmark suite + 4-gate model promotion
- Plan auto-save + auto-restore on compaction
- Effort levels (low/med/high)
- API + token for remote control (`apiPort`, `apiToken`)
- WebDAV sync for sessions

---

## Phased roadmap

Total estimated effort: **~6-8 weeks** of focused single-developer work.

### Phase 0 — Polish bar reset (1-2 days) ✅ SHIPPED 2026-05-03

Close every issue from the 2026-05-03 audit. No new features; just bring quality up to bar.

- [x] **P2** — Fixed `detectProject`. Added Node-CLI heuristic (`bin` field, `ink`, terminal-UI libs, arg-parsers). vcode now classifies as `Ink (Node CLI)`; llama_rider as `Node CLI`; burnrate stays `Next.js 16.2.2`.
- [x] **P3** — Reconciled `keybindings.ts` with actual handler. Wired Ctrl+Up/Down to scroll alongside Shift+Up/Down. Added Shift+Up/Down + Ctrl+Home/End to DEFAULT_BINDINGS so the file documents reality. Added doc comment noting `resolveKey` is currently a stub (Phase 1 wires it in).
- [x] **P4** — Implemented `SCROLL_TOP`/`SCROLL_BOTTOM` reducer cases. Bound `Ctrl+Home`/`Ctrl+End` (avoiding collision with input cursor `Home`/`End`). SCROLL_DOWN handles the saturation case from SCROLL_TOP gracefully.
- [x] **P5** — Deleted `tui/hooks/useMouseScroll.ts`.
- [x] **P6** — Added scrollback section to `/help`. Updated `README.md` with separate Input/Chat/Application keybinding tables.
- [x] **P7** — Trackpad scroll burst-disambiguator (already shipped earlier in 2026-05-03 session).
- [x] **P8** — Updated `vcode.config.example.json` with `remote.allow` example block + full Llama Rider integration sample.
- [x] **P9** — `shellHistoryContext` default flipped to `false` in `DEFAULTS`. Reflected in example config.
- [x] **P10** — Root cause: `execTool` in `benchmark-exercises.ts` coerced `undefined` path arg to literal string `"undefined"`. Added `requirePath()` validation to write_file/read_file/edit_file. Cleaned 11 stray `undefined` files from scratch. Already gitignored (`benchmarks/scratch/`).
- [x] **P11** — Startup banner: `[VEEPEE Code v0.3.0] pid=N model=X proxy=Y config=Z` written to stderr before alt-screen entry. Lives in user's terminal scrollback for post-mortem debugging.
- [x] **Polish-regression lint** — `scripts/check-polish.mjs` runs in prebuild; checks (1) every `KeyAction` is bound to at least one key; (2) every `AppAction` type has a reducer case; (3) every `Config` field has a `DEFAULTS` entry. Already caught 3 additional dead actions (`selectUp`, `selectDown`, `dismiss`) — removed from union.
- [x] **Bonus:** consolidated alt-screen handling. `TUI.start`/`stop` had inlined escape sequences instead of calling `enterAltScreen`/`exitAltScreen` from `screen.ts` — meaning earlier alt-scroll mode (`?1007h`) wasn't being applied on the live code path. Fixed by routing through shared helpers.
- [x] **Bonus:** removed misleading "j/k scroll" comment from TUI start (j/k only work in model selector, never bound for chat scroll).

**Exit criteria:** ALL MET.
- All P-IDs closed.
- `/help` documents every bound key.
- `npm run prebuild` includes polish-regression check; passes clean.
- `detectProject` correct on vcode + tested repos.
- Configs symmetric between code and example.

### Phase 1 — Foundation (5-7 days) ✅ SHIPPED 2026-05-03

The primitives every later feature depends on.

- [x] **F10 — Settings hierarchy.** Three layers (`~/.veepee-code/settings.json` global → `.veepee/settings.json` project → `.veepee/settings.local.json` local). Auto-migration from legacy `vcode.config.json` (kept as `.bak`). `loadConfig()` merges; `loadConfigLayered()` exposes per-layer for diagnostics. `saveConfigFile(config, layer)` writes to the right layer. `ensureLocalSettingsGitignored()` helper for the local layer. Verified end-to-end with synthetic project + local overrides.
- [x] **F2 — Hooks system.** `src/hooks.ts` runs shell commands at lifecycle events (PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification). Wired into agent.ts via `yield* this._fireHooks(...)`. PreToolUse non-zero exit blocks the tool call. Project/local hooks gated by per-cwd trust state in `~/.veepee-code/trusted-projects.json`. Startup banner prompts user to trust on first encounter. `/hooks`, `/hooks trust`, `/hooks deny` commands. Smoke-tested with bash matcher + write_file blocker; JSON payload reaches hook stdin via jq.
- [x] **F3 — User slash commands.** `src/user-commands.ts` discovers markdown files in `~/.veepee-code/commands/` (global) and `.veepee/commands/` (project, shadows global). YAML-style frontmatter (`description`, `argument-hint`); body is prompt template with `$1..$9`, `$ARGUMENTS`, `$@` substitution. Wired into `handleCommand` (takes precedence over hardcoded), tab-complete via `getAllCommands()` in tui/index.ts. Smoke-tested with three command shapes (with args, no args, no frontmatter).
- [x] **F6 — Diff preview before edits.** `src/diff.ts` — minimal LCS-based unified diff renderer (no new dep). `_previewToolCall` in agent.ts computes preview for edit_file/write_file; passed through `permissions.check(tool, args, preview)` into the TUI prompt handler. Preview shown above the y/n options. Smoke-tested with edit, new-file write, and no-op.
- [x] **Phase 1 polish-regression checks.** `scripts/check-polish.mjs` extended: (4) every `HOOK_EVENTS` name must be referenced in src/index.ts so undocumented events fail prebuild; (5) `settings.local.json` must be referenced in config.ts and `ensureLocalSettingsGitignored` helper must exist.

**Exit criteria:** ALL MET.
- Settings hierarchy verified with synthetic 3-layer override.
- Hook with `^bash$` matcher fires; hook returning exit 1 blocks the tool.
- User markdown command discovered, expanded with `$1` substitution, ran end-to-end.
- Edit preview emits a colored unified diff with stats footer.
- Polish-regression check passes.

### Phase 2 — Tool ecosystem (10-14 days) ✅ SHIPPED 2026-05-03

Open vcode to the broader AI tooling ecosystem.

- [x] **Refactor: ToolSource provenance.** `ToolSource = 'local' | 'remote' | 'mcp' | 'skill'` added to `ToolDef`; `ToolRegistry` gains `registerBatch`, `unregisterBySource`, `bySource()` for grouped listing. Existing remote bridge updated to set `source: 'remote', sourceName: 'llama-rider'`.
- [x] **F1 — MCP client (stdio).** Hand-rolled minimal client at `src/mcp.ts`: spawns child processes, JSON-RPC 2.0 over newline-delimited JSON. `initialize` → `notifications/initialized` → `tools/list` → `tools/call`. Per-server allowlist. Tool names namespaced as `mcp__<server>__<tool>` to avoid cross-server collisions. Stderr forwarded with `[mcp:server-name]` prefix. Smoke-tested with synthetic server: handshake + 2 tools + clean shutdown all pass.
- [x] **F1 — MCP client (SSE).** Two-sided HTTP transport using built-in `fetch`. Buffers outbound sends until the `endpoint` event arrives. Smoke-tested against synthetic SSE server: handshake + tool call + close all pass. No new deps.
- [x] **F4 — Skills system.** Markdown files in `~/.veepee-code/skills/` (global) and `.veepee/skills/` (project, shadows global). Frontmatter: name, description, tags?, model?, allowed-tools?. The crucial design: skills are NOT in the system prompt; only a compact INDEX is in the description of a single `skill_invoke` meta-tool. Body is fetched on demand via `skill_invoke({name})`. This is the same lazy pattern that took Llama Rider's prompt from 20k → 3k tokens. Smoke-tested with 2 skills (one with full frontmatter, one bare).
- [x] **Update /tools.** Grouped by source: local → remote → mcp → skill, with sub-groups by `sourceName`. Per-group counts. Bonus: `/skills` and `/mcp` direct-introspection commands.
- [x] **Phase 2 polish-regression checks.** scripts/check-polish.mjs grew checks: (5) every `ToolSource` value must be in `bySource` display order, (6) MCP transport shapes in McpServerConfig must be discriminated in the connect branch.

**Exit criteria:** ALL MET.
- MCP client handshakes both stdio and SSE servers; tools register correctly.
- Skills index loads, body fetched only on `skill_invoke`.
- `/tools` groups correctly with provenance visible.
- Polish-regression check passes.

### Phase 3 — Agent capabilities (7-10 days) ✅ SHIPPED 2026-05-03

Multi-agent and autonomy.

- [x] **F5 — Native subagents with fleet-aware routing.** `task` tool (src/tools/task.ts) spawns generic subagents with isolated context, configurable model + tool allowlist + maxTurns. Critical: model param routes to fleet server via Ollama Proxy header pinning, so a subagent on AGX (gemma4) genuinely runs in parallel with parent on DGX (Qwen3.6) — different silicon, not just batched on one. Default tool allowlist is read-only + web; mutations require explicit opt-in. Capacity capped at 4 concurrent (configurable via `subagent.maxConcurrent`).
- [x] **Subagent guardrail (added on user request).** `subagent.allowedModels` setting rejects model names not in the list before spawning. Prevents typos from triggering Ollama pull-and-load on fleets with pinned-per-server models. User's settings.json now has the three pinned models seeded (Qwen3.6-35B-A3B-FP8, gemma4:26b-a4b, qwen3:8b).
- [x] **F8 — Background subagents.** `run_in_background: true` flag returns immediately with agent ID; promise resolves async. `/agents` lists running + tracked, `/agents output <id>` blocks until done, `/agents stop <id>` aborts at next turn boundary. Background completions emit inline TUI notification + fire `Notification` hook (so users can route to Telegram/desktop via settings.json without code changes — composes with Phase 1 hooks).
- [x] **F7 — Plan-mode gate.** `exit_plan_mode` tool (src/tools/plan-gate.ts). Plan mode now FILTERS OUT mutating tools (`edit_file`, `write_file`, `bash`, `shell`, `docker` — listed in `PLAN_DISABLED_TOOLS`). To leave plan mode, model must call `exit_plan_mode({plan})`; tool surfaces plan via standard permission UI (plan rendered as preview, same path as edit_file diff), awaits user approval, then switches to act mode + persists `.veepee/plan.md`. Hard gate, not advisory.
- [x] **Phase 3 polish-regression checks.** Lint (7) PLAN_DISABLED_TOOLS entries must match real tool names registered in tools/, (8) SubagentConfig must be wired through DEFAULTS + loadConfig merge.

**Exit criteria:** ALL MET.
- Task tool registered, accepts model override, respects allowedModels guard.
- /agents listing shows running, completed, aborted; output retrievable; stop signals abort.
- Plan mode filters mutations; exit_plan_mode requires user approval; plan persists to disk.
- Polish-regression check passes.

### Phase 4 — UX polish (5-7 days) ✅ SHIPPED 2026-05-03

The 1% details that separate "competent" from "world-class."

- [x] **F9 — Image input.** Existing `extractImages` extended: now handles `@image.png` mentions (was: absolute paths only), bare filenames in cwd, dedupes paths mentioned multiple times. `expandFileMentions` skips image extensions so binary files no longer corrupt the user message. Auto-switch to vision-capable model preserved. Drag-drop and paste-from-clipboard left to terminal-level features (Ghostty/Kitty/iTerm support file drag-drop natively, OSC-52 image paste is rare and out of scope).
- [x] **F12 — Statusline customization.** `~/.veepee-code/statusline.sh` runs with state JSON on stdin (model, mode, tokens, tokenPercent, cwd, apiPort, apiConnected, version). Stdout becomes the right-aligned status. 30s cache, 5s timeout, falls back to built-in display when script absent or fails. Smoke-tested with a real bash script.
- [x] **F13 — Output styles.** Three built-ins (`default`, `explanatory`, `learning`) ship in-source so feature works zero-config. User overrides via markdown files in `~/.veepee-code/output-styles/<name>.md` (global) or `.veepee/output-styles/<name>.md` (project). Frontmatter: name, description; body becomes the prompt overlay. `/output-style [name]` command. Old standalone `styles.ts` removed in favor of unified module.
- [x] **F14 — Notebook editing.** `notebook_edit` tool with five actions: list/read/edit/insert/delete. Round-trips through nbformat 4 (preserves cell IDs, metadata, kernel spec). Code cell edits clear stale outputs. Smoke-tested with create-from-scratch + insert + edit + delete + JSON validity check.
- [x] **F15 — `@file` mentions with tab-complete.** New `src/tui/file-complete.ts`: detects `@<partial>` at cursor, globs cwd (excluding node_modules/dist/etc.), inline-replaces unique matches, extends to longest common prefix on multiple matches, lists candidates as a system message when ambiguous. Wired into the Tab handler. Smoke-tested with 5 cases (unique, ambiguous, no match, common-prefix expansion, no mention).
- [x] **Phase 4 polish-regression checks.** Lint (9) image extensions consistent between extractImages and expandFileMentions; (10) notebook_edit action enum exhaustive vs dispatch.

**Exit criteria:** ALL MET.
- `@file.png` mentions work end-to-end (tab-complete + image attach).
- Statusline replaceable via shell script with full state context.
- Three built-in output styles + custom overrides discovered correctly.
- Notebook tool round-trips cleanly through nbformat.
- Polish-regression check passes (10 checks now).

### Phase 5 — Cross-session memory (3-5 days)

Match the auto-memory system Claude Code has (and that I rely on heavily as your lead engineer).

- [ ] **F11 — Persistent memory.** Per-cwd memory dir at `.veepee/memory/` with `MEMORY.md` index and individual `.md` topic files (frontmatter: `name`, `description`, `type`). Types: `feedback`, `project`, `reference`, `user`. Auto-loaded on session start; `update_memory` tool writes new entries; `get_memory` searches by description.
- [ ] Memory shown in compacted form in system prompt (index only; topics fetched on demand).
- [ ] `/memory` command: list, view, edit, delete.
- [ ] Migration: keep current `update_memory` tool but route it to the new system.

**Exit criteria:** can drop a memory in session A, see it loaded in session B (same cwd), and have the model reference it correctly. Memory does not bloat system prompt past ~500 tokens regardless of size.

### Phase 6 — Differentiator amplification (3-5 days)

Now that we're at parity, lift up what's unique.

- [ ] Make MoE more accessible: `/moe quick` shortcut, MoE result caching, MoE-as-default for `/plan` mode.
- [ ] Cross-family reviewer: expose review-of-review via skills; let users define custom review chains.
- [ ] Fleet dashboard inline: `/fleet` shows GPU utilization + model loadout right in the TUI.
- [ ] Replay corpus integration with hooks (auto-record interesting failures).
- [ ] Token-budget visibility: per-tool token cost annotation, `Σ` cumulative cost in status bar.

**Exit criteria:** vcode's *unique* features feel as polished as the *parity* features.

---

## Sequencing rationale

1. **Phase 0 first.** No moving forward with fresh debt. Closing today's findings teaches us what "polish bar" means in this codebase, surfaces architectural friction early.
2. **Phase 1 before 2.** Hooks + slash commands + diff preview unblock everything else. They're prerequisites for skills (skills are slash commands with frontmatter), MCP (hook-driven server lifecycle), and subagents (hooks fire on subagent events).
3. **Phase 2 before 3.** Subagents need a unified tool registry to delegate from. Skills need to land before subagents to avoid building two competing "encapsulated capability" systems.
4. **Phase 3 before 4.** Image input + statusline are nice but additive; subagents change the agent fundamentals.
5. **Phase 5 toward end.** Memory schema benefits from understanding which features actually need cross-session state. Premature now.
6. **Phase 6 last.** Don't polish differentiators until parity work doesn't risk regressing them.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Token catalog bloats past ~3k → tool-pick accuracy drops on Qwen3.6 | HIGH | HIGH | Skills lazy-load via `skill_invoke`; allowlist applied across MCP + remote + skills |
| Hooks introduce arbitrary shell exec attack surface | MED | HIGH | Hooks only run from settings.json; project-local hooks require explicit "trust this project" prompt on first use |
| MCP SDK dependency drags in heavy deps | MED | MED | Evaluate hand-roll vs SDK; <1k LOC threshold for hand-roll |
| Subagent spawning + Ollama proxy slot exhaustion | MED | HIGH | Subagent runs through `proxyUrl` like everything else; cap concurrent subagents per `lockModel` slot count |
| Settings hierarchy migration breaks existing users | LOW | HIGH | Migration script reads old `vcode.config.json`, writes new layout; old file becomes `.bak`; tests covering both shapes |
| Polish work expands scope (every audit finds 5 more issues) | HIGH | MED | Time-box Phase 0 to 2 days; queue follow-ups but don't block forward progress |

---

## What's NOT in this plan

These are deliberately deferred or rejected:

- **IDE extensions.** CLI-first. Revisit only after parity ships and there's clear demand.
- **Claude API as fallback.** Hard no — breaks local-first promise.
- **Web app / hosted vcode.** Same.
- **Plugin marketplace.** Premature; Phase 6+ if at all.
- **Mobile.** Not a coding-agent use case.
- **Voice input.** Out of scope.

---

## Success criteria for "world-class"

We're done when:

1. A user coming from Claude Code can use vcode for a full week without hitting a "huh, that's not here" moment (excluding the cloud-vs-local distinction).
2. `npm run lint` passes with zero dead-code, dead-binding, or false-detection warnings.
3. `/help` documents every key, command, and feature.
4. A polish audit by an outside reviewer surfaces zero P0/P1 issues.
5. vcode's *unique* features (MoE, fleet awareness, cross-family review) are at least as polished as its parity features.
6. README has a "Why vcode over Claude Code" section that holds up to scrutiny.

---

## Triggers and resumption

**To start:** "begin world-class parity, phase 0" or "start the parity plan."
**To pivot:** "skip to phase N" if priorities change.
**To pause:** plan persists in this file; resume with phase number + checked items.
