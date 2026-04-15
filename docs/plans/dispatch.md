# Implementation Plan: `vcode dispatch`

**Source:** Analysis of Claude Cowork (Anthropic, 2026) and OpenAI Codex cloud agent (2025) during the 2026-04-14 session. Written to survive Claude Code context resets — everything needed to pick up and implement each phase without re-reading the competitors is contained below.

**Goal:** Add an async, multi-agent, review-first task surface to VEEPEE Code that mirrors the most useful parts of Cowork and Codex without cloning them. The output of a dispatched task is a git branch + draft PR, not an inline chat reply.

**Prerequisites:** Familiarity with the existing VEEPEE Code architecture — see `docs/architecture.md`, the memory file at `~/.claude/projects/-home-vp-Dev/memory/veepee-code-project.md`, and the existing worktree/subagent modules (`src/worktree.ts`, `src/subagent.ts`, `src/sessions.ts`).

---

## Table of Contents

1. [Context and motivation](#context-and-motivation)
2. [Goal and non-goals](#goal-and-non-goals)
3. [Architecture overview](#architecture-overview)
4. [Phase P0 — daemon + CLI skeleton](#phase-p0--daemon--cli-skeleton) — 1 day
5. [Phase P1 — headless agent runner](#phase-p1--headless-agent-runner) — 1 day
6. [Phase P2 — GitHub PR integration](#phase-p2--github-pr-integration) — ½ day
7. [Phase P3 — Telegram dispatch](#phase-p3--telegram-dispatch) — ½ day
8. [Phase P4 — parallel fan-out](#phase-p4--parallel-fan-out) — ½ day
9. [Phase P5 — benchmark/replay promotion gate](#phase-p5--benchmarkreplay-promotion-gate) — ½ day
10. [Phase P6 — fleet-aware scheduling](#phase-p6--fleet-aware-scheduling) — 1 day
11. [Phase P7 (stretch) — web dashboard](#phase-p7-stretch--web-dashboard) — 2 days
12. [Open questions](#open-questions)
13. [Trade-offs](#trade-offs)
14. [Cross-references — what already exists](#cross-references--what-already-exists)

**Total MVP effort:** ~3–4 focused sessions for P0–P3 (the part you'd actually use from your phone). P4–P7 are optional value-adds.

---

## Context and motivation

### What Cowork and Codex do that vcode doesn't

| Primitive | Claude Cowork | OpenAI Codex | vcode today |
|---|---|---|---|
| Async task dispatch | Dispatch (phone → desktop) | `@codex` on GitHub issues/PRs | ❌ — interactive REPL only |
| Per-task sandbox | VM isolation | Cloud sandbox per task | Partial — `worktree.ts` exists but only for interactive use |
| Parallel tasks | Projects + multi-session | Parallel agents, subagents | Partial — `subagent.ts` exists but only synchronous fan-out |
| Reviewable evidence | Computer-use screenshots + log | Terminal-log + test-output citations | ❌ — session JSON, no structured evidence bundle |
| Output format | Artifact inside Cowork | GitHub PR | Inline chat + local file edits |

### The shared pattern

Both products moved the agent from "interactive REPL while you watch" → "fire-and-forget task that returns a reviewable artifact." Five primitives enable that shift; vcode already has two and a half of them.

### Why build it

- Frees the laptop. Long tasks run on the VM (`vp@10.0.153.99`) while you're on a meeting or away from the keyboard.
- Phone-triggerable. You already use Telegram bots for notifications across newsfeed/constitutional/ollama_proxy. Dispatch is the inverse: phone → VM → PR.
- Parallel model comparison. Run the same task against `qwen3-coder:30b` on the DGX and `gpt-oss:120b` on the Orin; review both diffs and pick.
- Fills the gap between interactive vcode and scheduled cron.

### Why **not** build a Cowork clone

- No mobile UI needed — Telegram + the GitHub mobile app are the UI you already have.
- No VM-level computer use — vcode's scope is coding, not general office automation.
- No desktop Electron app — the terminal is fine for interactive work.

---

## Goal and non-goals

### Goals

1. Submit a task from CLI, Telegram, or HTTP. Get a task ID back.
2. Task runs headless on the VM in an isolated git worktree.
3. Task output is a branch + draft PR with an evidence-rich description.
4. Failures are recoverable — nothing is lost, nothing contaminates the main working tree.
5. Parallel tasks are a first-class primitive (not an accident).
6. Each task picks a model via the roster; caller can override with `--model`.

### Non-goals (for v1)

- No new UI beyond CLI / Telegram / GitHub PR.
- No authentication beyond "the Telegram chat ID is allowlisted" and "the CLI runs locally."
- No distributed execution. The daemon lives on one host (the VM). Workers are local processes, not remote k8s pods.
- No computer-use / browser automation. Coding tasks only.
- No persistence layer beyond JSON files on disk. (SQLite is a P8 stretch if scale demands it.)

---

## Architecture overview

### Components

```
┌──────────────────────────────────────────────────────────────────┐
│                      vcode dispatch daemon                        │
│                  (long-running, systemd-managed)                  │
│                                                                   │
│   ┌────────────┐   ┌─────────────┐   ┌────────────────────────┐   │
│   │  Intake    │   │   Queue     │   │   Worker pool          │   │
│   │ ─────────  │   │ ─────────   │   │ ───────────────────    │   │
│   │  HTTP API  │ → │  FIFO with  │ → │  N concurrent slots    │   │
│   │  Telegram  │   │  priority   │   │  each = worktree +     │   │
│   │  CLI       │   │  + retries  │   │  headless agent loop   │   │
│   └────────────┘   └─────────────┘   └────────────────────────┘   │
│                                              │                    │
│                                              ▼                    │
│                              ┌────────────────────────────────┐   │
│                              │  Outcome pipeline              │   │
│                              │  ───────────────────────────   │   │
│                              │  commit → push → gh pr create  │   │
│                              │     → Telegram notify          │   │
│                              │     → optional replay gate     │   │
│                              └────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

### File layout (new code)

```
src/dispatch/
├── daemon.ts           # entrypoint for `vcode dispatch daemon`
├── queue.ts            # durable FIFO queue, JSON-on-disk
├── worker.ts           # one task → one worktree → one headless agent
├── evidence.ts         # captures tool calls, shell output, test results
├── github.ts           # `gh pr create` wrapper + evidence rendering
├── telegram.ts         # bot loop: /task, /status, /cancel, /logs
├── http.ts             # POST /tasks, GET /tasks/:id, GET /tasks/:id/log
└── types.ts            # Task, TaskStatus, Evidence, Outcome

scripts/dispatch.ts     # CLI: `vcode dispatch <subcmd>`
benchmarks/dispatch/    # (empty for now — reserved for dispatch regression tests)

~/.veepee-code/dispatch/              # runtime state (NOT in repo)
├── tasks/<task-id>/
│   ├── task.json                      # the Task record
│   ├── evidence.jsonl                 # append-only log of every event
│   ├── worktree/                      # the git worktree (or symlink)
│   └── pr.json                        # final PR metadata
├── queue.json                         # live queue state
└── daemon.pid
```

### Task lifecycle

```
queued → assigned → running → committing → pr_open → done
                      │          │            │
                      └──────────┴────────────┴──→ failed / cancelled
```

Each transition appends to `evidence.jsonl`. The daemon can be killed and restarted; tasks resume from their last durable state by reading `task.json`.

### The Task record (`src/dispatch/types.ts`)

```typescript
export interface Task {
  id: string;                     // uuid
  createdAt: string;              // ISO timestamp
  updatedAt: string;
  source: 'cli' | 'telegram' | 'http';
  submitter?: string;             // telegram chat id, cli user, etc.
  repoPath: string;               // absolute path to source repo
  baseBranch: string;             // default: main
  branch: string;                 // dispatch/<id>-<slug>
  prompt: string;                 // the user's ask
  model?: string;                 // override; else roster.act
  mode: 'single' | 'fanout';      // fanout = run against N models in parallel
  fanoutModels?: string[];        // if mode=fanout
  status: TaskStatus;
  workdir: string;                // ~/.veepee-code/dispatch/tasks/<id>
  worktreePath?: string;
  prUrl?: string;
  error?: string;
  replayGate?: { ran: boolean; passed: boolean; report?: string };
}

export type TaskStatus =
  | 'queued' | 'assigned' | 'running'
  | 'committing' | 'pr_open' | 'done'
  | 'failed' | 'cancelled';
```

### Evidence log schema

Append-only JSONL. One event per line. Used both to render the PR description and to debug failures.

```typescript
export type EvidenceEvent =
  | { t: number; type: 'status'; from: TaskStatus; to: TaskStatus }
  | { t: number; type: 'tool_call'; name: string; args: unknown; result_preview: string }
  | { t: number; type: 'shell'; cmd: string; exit: number; out_tail: string }
  | { t: number; type: 'file_edit'; path: string; bytes_delta: number }
  | { t: number; type: 'test_run'; cmd: string; passed: number; failed: number; out_tail: string }
  | { t: number; type: 'agent_turn'; model: string; tokens_in: number; tokens_out: number; latency_ms: number }
  | { t: number; type: 'error'; message: string; stack?: string };
```

PR description is a Markdown render of this log: summary stats at top, collapsible details below.

---

## Phase P0 — daemon + CLI skeleton

**~1 day.**

Build the smallest possible dispatcher that doesn't actually run the agent yet. Prove the queue, the lifecycle, and the CLI surface before adding complexity.

### Files

- `src/dispatch/types.ts` — Task, TaskStatus, Evidence types above.
- `src/dispatch/queue.ts` — `enqueue(task)`, `claim()`, `update(id, patch)`, `list()`. Backed by `~/.veepee-code/dispatch/queue.json` + per-task `task.json`. Write-through, no locks needed at v1 concurrency (single daemon, single writer).
- `src/dispatch/daemon.ts` — loops: claim next queued task → transition to `assigned` → sleep or run → back to queue. At P0 just sleeps 2s and marks the task `done` with a stub PR.
- `scripts/dispatch.ts` — the `vcode dispatch` CLI with subcommands:
  - `daemon` — run the daemon in foreground
  - `submit "<prompt>" --repo <path> [--model <name>]` — enqueue and print task ID
  - `list` — show all tasks with status
  - `show <id>` — print the Task record + last 20 evidence lines
  - `logs <id>` — tail evidence.jsonl
  - `cancel <id>` — soft-cancel (worker checks the flag between agent turns)

### Acceptance criteria

- `vcode dispatch daemon &` starts cleanly; writes `daemon.pid`.
- `vcode dispatch submit "hello" --repo ~/Dev/veepee-code` prints a UUID; file appears under `~/.veepee-code/dispatch/tasks/<id>/`.
- `vcode dispatch list` shows the task moving through `queued → assigned → done` within ~3s.
- Daemon survives `kill -9` mid-task — on restart, orphaned `running` tasks are moved to `failed` with reason `daemon restart`.

### Testing

`test/dispatch-queue.test.ts` — unit tests for queue state transitions (no agent, no git).

---

## Phase P1 — headless agent runner

**~1 day.** Builds on P0.

Make the daemon actually run the vcode agent loop against a worktree and capture evidence.

### What needs to happen per task

1. **Prep worktree** — reuse `src/worktree.ts::createWorktree(repoPath, branch, baseBranch)`. Worktree goes under the task workdir so cleanup is atomic.
2. **Build an agent session** — reuse the existing `Agent` class from `src/agent.ts`, but in **headless mode**: no TUI, no interactive prompts. Wire `onEvent` callbacks into `evidence.ts` so every tool call, shell exec, file edit lands in `evidence.jsonl`.
3. **Run the loop** — feed the user prompt; let the agent run until it stops calling tools or hits a configurable turn cap (default 30).
4. **Capture final state** — list of modified files, diff stat vs base branch, any test results seen.
5. **Handle timeouts / cancellation** — check a cancel flag between turns; hard-timeout the whole task at 30 minutes by default.

### New code

- `src/dispatch/worker.ts` — the main worker. Roughly:
  ```typescript
  export async function runTask(task: Task): Promise<Outcome> {
    const evidence = new EvidenceWriter(task.workdir);
    const wt = await createWorktree(task.repoPath, task.branch, task.baseBranch);
    await evidence.status('assigned', 'running');
    const model = task.model ?? getRoster().act;
    const agent = new HeadlessAgent({ cwd: wt.path, model, evidence, toolRegistry });
    await agent.run(task.prompt, { maxTurns: 30, timeoutMs: 30 * 60_000 });
    const diff = await computeDiff(wt.path, task.baseBranch);
    return { task, worktree: wt, diff, evidence: evidence.path };
  }
  ```
- `src/dispatch/evidence.ts` — `EvidenceWriter` with typed methods (`toolCall`, `shell`, `fileEdit`, `testRun`, `agentTurn`, `status`, `error`).
- Refactor in `src/agent.ts` — extract a headless-friendly entry point if the current Agent class assumes TUI state. **Do not break the interactive path**; add a second constructor or a `headless` option.

### Headless agent requirements

- No stdin reads.
- No `askUser` / permission prompts — at v1, tasks run with permissions preset to `approved` (document this; a Telegram "request permission" loop can come later).
- All output goes to the evidence writer, not stdout.
- Resource limits: max 30 turns, max 30 min wall clock, max 50 tool calls (configurable).

### Acceptance criteria

- `vcode dispatch submit "add a one-line comment at the top of README.md saying 'hello dispatch'" --repo ~/Dev/veepee-code` produces a worktree with exactly that edit, committed on the dispatch branch.
- `evidence.jsonl` for that task has at least one `tool_call` (write_file/edit_file) and one `file_edit` event.
- Mid-task `vcode dispatch cancel <id>` transitions the task to `cancelled` within 10s (between turns).
- Hard timeout works: a prompt designed to loop forever gets killed at 30 min with status `failed` and reason `timeout`.

### Tricky bits

- Worktree cleanup on failure — worker must ALWAYS call `removeWorktree` in a finally block, but only for the task's own worktree, never any other.
- Git state discipline — commit with a specific `GIT_AUTHOR_NAME=vcode-dispatch` so these commits are trivially filterable. Use `--allow-empty` tolerance only when intended.
- Concurrent worktrees on the same repo — git supports this natively; no extra locking needed as long as each task uses a distinct branch name.

---

## Phase P2 — GitHub PR integration

**~½ day.** Builds on P1.

Turn every successful task into a draft PR with an evidence-rich body.

### What `src/dispatch/github.ts` does

1. After `runTask` succeeds and has a non-empty diff:
   - `git push origin <branch>` (use SSH remote; fail gracefully if repo has no remote).
   - `gh pr create --draft --title "<slug>" --body "<rendered evidence>"` from the worktree path.
   - Store PR URL back on the task record.
   - Transition `committing → pr_open → done`.
2. PR body layout (Markdown):

   ```
   ## Dispatch task <task-id>

   **Prompt:** <first 500 chars>
   **Model:** <model>  **Turns:** <n>  **Duration:** <mm:ss>
   **Diff stat:** <N files, +X −Y>

   ### Files changed
   - src/foo.ts (+12 −3)
   - src/bar.ts (+42 −0)

   ### Evidence summary
   - 18 tool calls: 7× read_file, 5× edit_file, 4× bash, 2× grep
   - 3 shell commands: 2 passed, 1 exit 1 (see log)
   - Tests: 42 passed, 0 failed

   <details><summary>Full evidence log</summary>

   ```jsonl
   [first 200 events — truncate rest with "N more events, see <path>"]
   ```

   </details>
   ```

3. If diff is empty: do NOT open a PR. Mark task `done` with note `no-op (empty diff)`.
4. If push fails: mark `failed` with reason; leave the worktree in place for inspection.

### Acceptance criteria

- Successful task opens a draft PR; URL appears in `task.json` and in `vcode dispatch show <id>`.
- Empty-diff task is marked `done` with note `no-op`, no PR created.
- Failed-push task is marked `failed`; worktree remains for debugging; running `vcode dispatch retry <id>` re-attempts the push without re-running the agent.

### Prerequisite

`gh` CLI installed and authenticated on the daemon host (`10.0.153.99`). Already present — user has it for other projects.

---

## Phase P3 — Telegram dispatch

**~½ day.** Builds on P2.

A phone → VM → PR loop.

### New code

- `src/dispatch/telegram.ts` — polls a Telegram bot token; routes commands.

### Commands

- `/task <prompt>` — enqueue. Reply with task ID + `vcode dispatch show` URL stub.
- `/status` — last 10 tasks for the submitter.
- `/show <id>` — task record summary.
- `/cancel <id>` — soft-cancel.
- `/logs <id>` — last 30 evidence events.

### Notifications

On `pr_open` and `failed`, send the submitter a message:

```
✅ Task <id> done
  Prompt: <first 200 chars>
  PR: <url>
  +42 −7 across 3 files, 18 tool calls, 12 s
```

or:

```
❌ Task <id> failed
  Prompt: <first 200 chars>
  Reason: <reason>
  Logs: /logs <id>
```

### Security

- `DISPATCH_TELEGRAM_BOT_TOKEN` in env.
- `DISPATCH_TELEGRAM_ALLOWED_CHATS` — comma-separated chat IDs. Ignore messages from anyone else, silently.
- Default-deny: empty allowlist means no Telegram intake, but the HTTP/CLI paths still work.

### Acceptance criteria

- `/task add a newline at the end of README.md` from phone → task enqueued → PR opened → phone gets the "done" notification with PR URL within ~2 minutes.
- Messages from un-allowlisted chat IDs are silently dropped (log line only).

### Cross-reference

Pattern is identical to the Telegram bot in `~/llama_rider` and `~/content_triager`. Same token-in-env + allowlist model. Memory file: [`telegram-bots.md`](file:///home/vp/.claude/projects/-home-vp-Dev/memory/telegram-bots.md).

---

## Phase P4 — parallel fan-out

**~½ day.** Builds on P1.

One prompt → N worktrees → N agent runs in parallel against N different models → N draft PRs (or one comparison report).

### CLI

```
vcode dispatch submit "refactor src/foo.ts to use Result<T,E>" \
  --repo ~/Dev/veepee-code \
  --fanout qwen3-coder:30b,gpt-oss:120b,mistral-small3.2:24b
```

### Daemon changes

- `mode: 'fanout'` tasks expand on enqueue into N sibling tasks with the same prompt and distinct branches: `dispatch/<parent-id>-<model-slug>`. A parent task record is kept with child IDs; `show <parent-id>` renders a table.
- Fan-out respects the worker-pool size. If pool = 3 and fan-out = 5, the daemon just schedules naturally.
- Each child opens its own draft PR. An extra post-step on the parent task generates a comparison Markdown file (file-level diff stats side-by-side, plus test results if the agent ran tests) and either:
  - Attaches it as a comment on each child PR, or
  - Creates a parent "meta" issue/PR that links to all children.

### Acceptance criteria

- `--fanout a,b,c` produces 3 draft PRs with branches named consistently.
- Parent task status reaches `done` only when all children have terminated (success or fail).
- Cancelling the parent cancels all pending children.

### Why this matters

This is the single feature that doesn't exist in Cowork or Codex in an accessible form. It only makes sense because you own an Ollama fleet — running the same task on three local models costs you watt-hours, not dollars.

---

## Phase P5 — benchmark/replay promotion gate

**~½ day.** Builds on P4 and the benchmark work already shipped.

Before marking a fanout comparison "done," optionally run the replay corpus (`scripts/replay-corpus.ts`) against each candidate to flag regressions.

### How it plugs in

- `vcode dispatch submit --fanout a,b,c --gate replay` — after agents finish, runs `scripts/replay-corpus.ts --candidate <model>` for each. The comparison report gets a "replay pass rate" column.
- Any model that drops >10% vs baseline gets flagged in red.
- `--gate replay --promote-if-pass` — if all children pass and one clearly wins, update the roster.

### Acceptance criteria

- Gate runs automatically after fan-out when `--gate replay` is passed.
- Comparison report includes replay pass rate per child.
- `--promote-if-pass` edits `~/.veepee-code/benchmarks/roster.json` only when conditions are met; otherwise logs why it didn't promote.

### Cross-reference

Just-shipped replay infra: `scripts/replay-corpus.ts` (P2 of the benchmark plan). Memory: [`veepee-code-benchmark-overhaul.md`](file:///home/vp/.claude/projects/-home-vp-Dev/memory/veepee-code-benchmark-overhaul.md).

---

## Phase P6 — fleet-aware scheduling

**~1 day.** Polish. Do this once P0–P3 have shipped and real use surfaces the pain points.

The daemon consults the ollama_proxy health endpoint before assigning a task to a model; it also pins the call to a specific server when the model exists on multiple nodes.

### What changes

- `src/dispatch/scheduler.ts` — given a task (and optional `--server` hint), picks:
  1. An idle model that matches the role (or explicit `--model`).
  2. The server with the lowest current queue depth (from ollama_proxy metrics).
  3. A "resource tier" match: heavy tasks → DGX, light subagent tasks → Orin/Nano.
- Worker sets the `X-Ollama-Server` header (or equivalent) to pin the model.
- If the preferred server is hot, the scheduler can either queue or auto-switch to a smaller roster-approved model (respect `--strict-model` to disable).

### Acceptance criteria

- Heavy code-gen task submitted with no `--server` hint lands on DGX.
- Light search subagent lands on Orin/Nano.
- Fleet node offline → scheduler skips it; task still completes on another node.

### Cross-reference

Ollama fleet routing rules already in memory: [`ollama-fleet-routing.md`](file:///home/vp/.claude/projects/-home-vp-Dev/memory/ollama-fleet-routing.md). Proxy hardening plan: [`proxy-hardening.md`](file:///home/vp/.claude/projects/-home-vp-Dev/memory/proxy-hardening.md) — P6 here partially overlaps; worth checking which side owns what.

---

## Phase P7 (stretch) — web dashboard

**~2 days.** Only if the CLI+Telegram surfaces don't cut it.

A minimal Hugo or Astro-style static dashboard served by the daemon on port 3400:

- Task list with status pills
- Diff preview (use `diff2html` or similar)
- Evidence timeline
- One-click "Retry," "Cancel," "Merge PR" (delegating to `gh`)

If built, mirror the pattern of `vpfinance` / `burnrate` — same host, same style, same auth story (none — local network only; front with caddy/twingate if you care).

Note: this is the thing you probably don't need. The GitHub PR IS the dashboard. Only build this if you find yourself CLI-jumping between 5+ concurrent tasks.

---

## Open questions

Worth deciding before P0 starts. These are the kind of things that are painful to change later.

1. **Where does the daemon live?**
   - VM (`10.0.153.99`) is the obvious choice — always-on, already hosts the other services. **Default: VM.**
   - Laptop would work but fails the "phone dispatch while laptop asleep" use case.

2. **How does the daemon authenticate to GitHub?**
   - Reuse the VM's existing SSH key + `gh auth login`. **Default: yes, same as other projects.**
   - Separate deploy key per dispatched repo would be more principled but overkill for personal use.

3. **How does a dispatched task get a permissions preset?**
   - v1: all permissions pre-approved (document the risk — task can run any shell command).
   - v2: permission events are posted back to Telegram with `/approve <id>` inline.
   - **Default: v1 for P0–P3, revisit if you feel the need.**

4. **Do tasks persist across daemon restart?**
   - Yes — queue and task state are on disk. Running tasks are marked `failed` with `daemon restart` reason and can be `retry`'d. (Implemented in P0.)

5. **What's the concurrency default?**
   - `DISPATCH_WORKERS=3`. Three models can happily run on the fleet in parallel without interfering. Configurable.

6. **Repo path — absolute or slug?**
   - v1: submit with absolute path, daemon uses it directly.
   - v2: maintain a `~/.veepee-code/dispatch/repos.json` mapping slugs → paths, so `--repo newsfeed` works from phone. **Default: absolute in P0, slug lookup as part of P3 (Telegram) since typing absolute paths from phone is miserable.**

7. **What happens if the branch name collides?**
   - Impossible under normal ops because task IDs are UUIDs. But be defensive: append `-<rand4>` if `git show-ref` says the branch exists.

8. **Session reuse / memory?**
   - v1: each task is a fresh context. No shared memory across tasks.
   - v2: `--resume <task-id>` for follow-up edits. Low priority.

9. **What about non-git repos?**
   - v1: reject. All vcode-repo projects are git. Keep it simple.

10. **Cost / budget controls?**
    - Irrelevant for local Ollama, but worth adding `--max-tokens` and `--max-shell-calls` safety caps per task. **Default: cap implemented, values configurable.**

---

## Trade-offs

### What we gain

- Real async — finally, a reason to leave a vcode task running.
- Parallel model comparison — the thing Codex cannot do because it only runs one vendor's models.
- GitHub-PR output format — diffs are reviewable on any device, including phone.
- Reuses ~70% of existing vcode internals (worktree, subagent, sessions, roster, benchmark).
- Slots cleanly into the existing Telegram / gh / ollama_proxy world.

### What this costs

- More moving parts. A long-running daemon is an operational surface we don't have today. Bugs will be subtle (half-written state files, orphan worktrees, zombie branches).
- Pre-approved permissions at v1 is a real risk. If someone gets a Telegram token they can run arbitrary shell commands as `vp` on the VM. Mitigations: allowlist chat IDs, scope the agent's tools, consider a "shell allowlist" mode for untrusted submitters.
- Headless agent path must stay in sync with the interactive agent forever. Every new feature that touches `Agent` needs to not break headless mode. Worth adding a smoke test in CI: `vcode dispatch submit "echo hello" --repo tmp-repo && assert pr_open`.
- The `evidence.jsonl` format is a public-ish schema — once real tasks depend on it, breaking changes are painful. Version it from the start.
- Parallel fan-out eats fleet capacity. If you're running interactive vcode AND a 5-way fan-out, the Orin's queue will back up. P6 (fleet-aware scheduling) partially fixes this, but not perfectly.

### Where this could fail

- Phone dispatch turns out to be used ~zero times. The wall-of-PRs workflow from desktop is the real value. In that case, P3 (Telegram) stays optional; the core is still worth building.
- Agent's headless permission story leaks, and tasks do destructive things that require manual cleanup. Mitigation: treat task workdirs as disposable; never have the agent write outside the worktree.

---

## Cross-references — what already exists

Don't rebuild these; wire into them.

| Need | Existing module | Notes |
|---|---|---|
| Isolated working dir per task | `src/worktree.ts` | `createWorktree` + `removeWorktree`. Already hardened. |
| Spawning a focused sub-loop | `src/subagent.ts` | Useful for task pre-flight ("summarize repo layout before editing"). |
| Model selection by role | `src/benchmark.ts::ModelRoster` + `~/.veepee-code/benchmarks/roster.json` | Default task model = `roster.act`. Fan-out reads the full leaderboard. |
| Per-role speed floors | `Benchmarker.ROLE_MIN_TPS` | Reject tasks that pick a chat-unfit model without `--strict-model`. |
| Tool registry | `src/tools/registry.ts` + `benchmarks/tool-registry.json` | Headless agent gets the same registry. |
| Ollama client | `ollama` npm package, fleet config | Single-endpoint for v1 (proxy), fleet-aware in P6. |
| Session persistence | `src/sessions.ts` | Reuse the JSON-file pattern; tasks are a sibling directory, not sessions. |
| GitHub CLI | `gh` on VM | Already authenticated. Reuse the SSH remote convention. |
| Telegram bot pattern | `~/llama_rider`, `~/content_triager` (remote) | Token in env, allowlist, polling-based. Copy the skeleton. |
| Benchmark replay gate | `scripts/replay-corpus.ts` + tool-registry | Imported in P5 without modification. |

---

## Suggested sequencing

1. **P0** (1 day) — daemon + CLI, no agent. Prove the state machine.
2. **P1** (1 day) — headless agent. This is the one that might surprise you; the interactive `Agent` class probably needs refactoring to extract a headless path.
3. **P2** (½ day) — GitHub PR integration. You'll feel real value here: your first dispatched PR.
4. **P3** (½ day) — Telegram. Unlocks phone submission.
5. **Pause and actually use it for 1–2 weeks.** Fix the real pain points before adding more.
6. **P4** (½ day) — fan-out, once you know whether you want it.
7. **P5** (½ day) — replay gate, once fan-out is in and the benchmark has actually been re-run.
8. **P6** (1 day) — fleet-aware scheduling, if concurrency pain is real.
9. **P7** (2 days, skip unless needed) — web dashboard.

**MVP to "my phone opens PRs on my VM" = P0 + P1 + P2 + P3 ≈ 3 days of focused work.**

---

## Success metric

> You submit a non-trivial refactoring task from your phone during a meeting. It opens a PR with 12 file changes, 300 lines, green tests, and a clear evidence summary. You review the diff on the GitHub mobile app, leave one review comment requesting a tweak, and `/retry <id> --with-comment` runs the fix. You merge. Total elapsed: 25 minutes. Total time you were actively at the keyboard: 3 minutes.

If that works once, the feature has paid for itself.

---

## Author notes

Written while the benchmark overhaul (P0–P7 of the other plan) had just shipped and was waiting to run. Context is fresh on where the existing building blocks are. If implementing this after a long gap, re-read:

- `docs/architecture.md` — overall vcode layout
- `src/agent.ts` — the main agent loop (this is where the headless refactor in P1 happens)
- `src/worktree.ts` — the worktree primitive that everything below depends on
- This session's commit `2c65ed1` — for the benchmark infra that P5 hooks into
