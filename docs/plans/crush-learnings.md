# Implementation Plan: Crush Learnings

**Source:** Analysis of [charmbracelet/crush](https://github.com/charmbracelet/crush) (~75k LOC Go) during 2026-04-11 session. Written to survive Claude Code context resets — everything needed to pick up and implement each item without re-reading crush is contained below.

**Goal:** Port the 10 highest-value design ideas from crush into VEEPEE Code, ranked by value-to-effort ratio.

**Prerequisites:** Familiarity with the existing VEEPEE Code architecture — see `docs/architecture.md` and the memory file at `~/.claude/projects/-home-vp-Dev/memory/veepee-code-project.md` for the full picture.

---

## Table of Contents

1. [Hash-signature loop detection](#1-hash-signature-loop-detection) — 30 min
2. [File staleness check on edits](#2-file-staleness-check-on-edits) — ½ day
3. [The `agent` tool — wire up SubAgentManager as a real tool](#3-the-agent-tool) — 1 hour
4. [Multi-edit with atomic rollback](#4-multi-edit-with-atomic-rollback) — ½ day
5. [Two-model split + semantic summarization on compact](#5-two-model-split--semantic-summarization) — 1 day
6. [Skills catalog pattern (on-demand SKILL.md loading)](#6-skills-catalog-pattern) — 1-2 days
7. [Pub/sub permission broker](#7-pubsub-permission-broker) — 1 day
8. [MCP client support (stdio/http/sse)](#8-mcp-client-support) — 2-3 days
9. [Catwalk-style provider metadata registry](#9-catwalk-style-provider-metadata-registry) — 1-2 days (lower priority)
10. [LSP diagnostics inlined into edit tool results](#10-lsp-diagnostics-inlined-into-edit-tool-results) — weeks, biggest quality multiplier

**Plus bonus items:**
- [B1: Reflective JSON Schema export (`vcode schema`)](#b1-reflective-json-schema-export) — ½ day

**Suggested sequencing:** implement in the order above. Items 1-4 are quick wins that unblock item 8 (LSP) by making the agent loop more robust. Items 5-7 can be done in parallel. Item 10 (LSP) is the big fish and deserves its own plan-mode design session before coding.

---

## 1. Hash-signature loop detection

**Effort:** ~30 minutes. Pure upgrade. No downside.

**Why:** VEEPEE Code's current stuck-loop check (`src/agent.ts` ~line 785) only fires on 3 byte-identical *consecutive* tool calls. It misses `ABABAB` oscillation and `A call, A call, B call, A call` patterns. Crush catches both.

**Crush reference:** `/tmp/crush/internal/agent/loop_detection.go` (93 lines). The full algorithm:

```go
const (
    loopDetectionWindowSize = 10
    loopDetectionMaxRepeats = 5
)

func hasRepeatedToolCalls(steps []StepResult, windowSize, maxRepeats int) bool {
    if len(steps) < windowSize { return false }
    window := steps[len(steps)-windowSize:]
    counts := make(map[string]int)
    for _, step := range window {
        sig := getToolInteractionSignature(step.Content)
        if sig == "" { continue }
        counts[sig]++
        if counts[sig] > maxRepeats { return true }
    }
    return false
}

// Signature = sha256(toolName \x00 input \x00 output)
// The key insight: hash BOTH input AND output. "Same call, same output" is
// the stuck signal. "Same call, different output" is productive iteration.
```

**Port plan (TypeScript):** Modify `src/agent.ts` around the existing `MAX_IDENTICAL_CALLS` check.

```typescript
// At top of file or in a new loop-detection module
import { createHash } from 'node:crypto';

const LOOP_WINDOW = 10;
const LOOP_MAX_REPEATS = 5;

type SignedStep = { signature: string };
const recentSteps: SignedStep[] = [];

function signatureOf(toolCalls: ToolCall[], results: Array<{name: string, content: string}>): string {
  if (toolCalls.length === 0) return '';
  const resultsByName = new Map(results.map(r => [r.name, r.content]));
  const h = createHash('sha256');
  for (const call of toolCalls) {
    h.update(call.function.name);
    h.update('\x00');
    h.update(JSON.stringify(call.function.arguments ?? {}));
    h.update('\x00');
    h.update(resultsByName.get(call.function.name) ?? '');
    h.update('\x00');
  }
  return h.digest('hex');
}

function isStuck(steps: SignedStep[]): boolean {
  if (steps.length < LOOP_WINDOW) return false;
  const window = steps.slice(-LOOP_WINDOW);
  const counts = new Map<string, number>();
  for (const step of window) {
    if (!step.signature) continue;
    counts.set(step.signature, (counts.get(step.signature) ?? 0) + 1);
    if ((counts.get(step.signature) ?? 0) > LOOP_MAX_REPEATS) return true;
  }
  return false;
}
```

Wire it into the agent loop: after each step (tool calls + results collected), compute the signature, push to `recentSteps`, call `isStuck`. If true, yield `error` event and return.

**Remove:** the old `recentToolCalls`/`MAX_IDENTICAL_CALLS` block. Replace with the new signature-based check. Keep the "15 turns without output" check — it catches a different failure mode.

**Validation:**
- Unit test in `test/agent.test.ts`: feed a fake step array with `A A A A A A` → `isStuck === true`.
- Test `A B A B A B A B A B` (5+ repeats of each in a 10 window) → true.
- Test `A A B B A A B B A A` (productive alternation, fewer than 5 repeats of any single sig) → false.
- Test same input, different output → false (productive iteration).

**Risks:** None. Strictly stronger than current behavior.

---

## 2. File staleness check on edits

**Effort:** ~½ day.

**Why:** `edit_file` and `write_file` happily overwrite the file even if it has changed on disk since the model last saw it — from a user's manual edit, a watcher, a formatter, or a different agent. Subtle but real foot-gun during long sessions.

**Crush reference:** `/tmp/crush/internal/filetracker/` — tracks `{sessionID, path, readAt}` in SQLite. Edit tool in `internal/agent/tools/edit.go` checks `fileModTime > lastReadTime` before allowing changes and returns a clear error pointing the agent at the view tool if stale.

**Port plan:**

1. **Add a `FileTracker` class** in `src/filetracker.ts`:

```typescript
export class FileTracker {
  private readAt = new Map<string, number>(); // absolute path → ms timestamp

  recordRead(absPath: string): void {
    this.readAt.set(absPath, Date.now());
  }

  /** Returns null if fresh, or an error message if stale / never-read. */
  checkFresh(absPath: string): string | null {
    const last = this.readAt.get(absPath);
    if (!last) {
      return `File ${absPath} was not read in this session. Read it first with read_file before editing.`;
    }
    try {
      const stat = statSync(absPath);
      if (stat.mtimeMs > last) {
        return `File ${absPath} was modified on disk after you last read it (mtime=${new Date(stat.mtimeMs).toISOString()}, last read=${new Date(last).toISOString()}). Re-read it before editing to see the current content.`;
      }
    } catch (err) {
      // File doesn't exist yet — that's fine for write_file (new files)
      return null;
    }
    return null;
  }

  forget(absPath: string): void {
    this.readAt.delete(absPath);
  }
}
```

2. **Wire into tools** in `src/tools/coding.ts`:
   - `read_file` execute() → after successful read, call `fileTracker.recordRead(resolvedPath)`
   - `edit_file` execute() → at start, call `fileTracker.checkFresh(resolvedPath)`; if stale, `return fail(msg)` without touching the file
   - `write_file` execute() → same, but only check if the file *already exists* (creating a new file is always fine)
   - After successful write/edit, `fileTracker.recordRead(resolvedPath)` so subsequent edits see the current state.

3. **Ownership:** The `FileTracker` instance belongs to the `Agent` (one per session). Pass it to `registerCodingTools(ignoreManager, fileTracker)`. Update the signature in `index.ts`.

4. **Persistence question:** crush persists to SQLite so staleness survives sessions. VEEPEE Code runs as a single process per session, so in-memory is fine. But: if we add `/resume` support for stale-checking, we'd need to serialize `readAt` into the session JSON. **Skip for v1** — only check within the live session.

**Validation:**
- Unit test: recordRead → checkFresh is fine → `touch` the file → checkFresh returns error.
- Integration: in a real run, `read_file` foo.ts → external `echo X >> foo.ts` → `edit_file` foo.ts should refuse.

**Risks:**
- False positives if the agent itself writes through `bash("sed -i ...")`. Mitigation: after any `bash` tool call, forget tracker entries for paths mentioned in the command (heuristic) or just accept that bash bypasses tracking.
- `stat()` latency on every edit. Negligible.

---

## 3. The `agent` tool

**Effort:** ~1 hour. This is the lowest-effort item with a real unlock — you already have `SubAgent` and `SubAgentManager` built (`src/subagent.ts`, 200 lines) but they're never called from the agent loop.

**Why:** Crush exposes a literal `agent` tool the model can call to spawn a sub-agent for a sub-task. VEEPEE Code's subagent infra is dead code without this.

**Crush reference:** `/tmp/crush/internal/agent/agent_tool.go` (67 lines) wraps a sub-agent in `NewParallelAgentTool`.

**Port plan:** Add three new tools to `src/tools/coding.ts` (or a new file `src/tools/subagent.ts`):

```typescript
function createSubAgentSearchTool(subAgents: SubAgentManager | null): ToolDef {
  return {
    name: 'delegate_search',
    description: 'Delegate a focused search task to a lightweight sub-agent running on a smaller model. Use for: exploring an unfamiliar codebase, finding where something is defined, looking up external info via web_search. Returns a summary, not raw output. Does not touch files.',
    schema: z.object({
      task: z.string().describe('Detailed description of what to search for and what to return'),
    }),
    execute: async (params) => {
      if (!subAgents) return fail('Sub-agents not available (no roster loaded yet)');
      const result = await subAgents.search(params.task as string);
      if (!result.success) return fail(result.error ?? 'sub-agent failed');
      return ok(`Sub-agent (${result.model}, ${result.elapsed}ms):\n\n${result.content}`);
    },
  };
}

function createSubAgentReviewTool(subAgents: SubAgentManager | null): ToolDef { ... }
function createSubAgentSummarizeTool(subAgents: SubAgentManager | null): ToolDef { ... }
```

**Wiring:** `SubAgentManager` is constructed inside `Agent` currently (only after roster loads). Expose it via a getter `agent.getSubAgents()` (already exists) and pass to `registerCodingTools`. Or, pass the agent itself and let tools query `agent.getSubAgents()` lazily on each call (handles "roster loaded after first turn" case).

**Variant worth considering:** crush's version is `NewParallelAgentTool` which means the model can call multiple sub-agents in the *same turn* and they run concurrently. Your `registry.ts` already parallelizes read-only tools via `Promise.all` in `agent.ts` — if we mark these delegation tools as read-only, they'll get the same treatment for free. Add `delegate_search`, `delegate_review`, `delegate_summarize` to `READ_ONLY_TOOLS` in `agent.ts`.

**Validation:**
- Unit test: feed `delegate_search` a task, assert it returns a result with `model` and `content` fields.
- Manual: `/plan then ask the agent to "use delegate_search to find where auth is handled, then write a plan to refactor it"` and verify the sub-agent's summary appears in the tool_result.

**Risks:** Sub-agents cost real tokens. Surface this in the tool description so the main agent doesn't delegate trivial things.

---

## 4. Multi-edit with atomic rollback

**Effort:** ~½ day.

**Why:** Today the agent makes N sequential `edit_file` calls for multi-op refactors. If op 3 fails, ops 1-2 are already committed and there's no way to roll back. Crush's `multiedit` validates all ops upfront, applies them in order, and aborts with a structured failure report at the first broken op — leaving earlier edits intact but signaling clearly what failed.

**Crush reference:** `/tmp/crush/internal/agent/tools/multiedit.go` (431 LOC). Note: crush's semantics are actually "validate all, then apply in order, stop on first failure" — so it's *atomic validation* not *atomic application*. The failure message tells the agent "ops 1-2 succeeded, op 3 failed because X". I'll port the same semantics.

**Port plan:** New tool `multi_edit` in `src/tools/coding.ts`:

```typescript
function createMultiEditTool(ignoreManager?: IgnoreManager, fileTracker?: FileTracker): ToolDef {
  return {
    name: 'multi_edit',
    description: 'Apply multiple edits to a single file atomically-validated. All edits are checked against the current file before any are applied; edits are then executed in order. On the first failure, the tool stops and reports how many edits succeeded and which op failed. Use this for multi-step refactors on a single file to avoid partial writes.',
    schema: z.object({
      path: z.string(),
      edits: z.array(z.object({
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional().default(false),
      })).min(1),
    }),
    execute: async (params) => {
      const filePath = resolve(params.path as string);
      const blocked = ignoreManager?.getBlockedReason(filePath);
      if (blocked) return fail(`Access blocked by .veepeignore: ${filePath}`);

      const stale = fileTracker?.checkFresh(filePath);
      if (stale) return fail(stale);

      const edits = params.edits as Array<{old_string: string, new_string: string, replace_all?: boolean}>;
      let content = await readFile(filePath, 'utf-8');

      // Phase 1: validate all edits can be applied (check occurrence counts only)
      // We cannot simulate application here because later edits depend on earlier ones.
      // Instead, walk the edits in sequence and check each against the running content.
      const results: Array<{op: number, ok: boolean, error?: string, matchCount?: number}> = [];
      let working = content;

      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const occurrences = working.split(e.old_string).length - 1;
        if (occurrences === 0) {
          // Try fuzzy match (same logic as edit_file)
          const fuzzy = tryFuzzyEdit(working, e.old_string, e.new_string, e.replace_all ?? false);
          if (fuzzy === null) {
            results.push({op: i, ok: false, error: `old_string not found`});
            break;
          }
          working = fuzzy.updated;
          results.push({op: i, ok: true, matchCount: fuzzy.matchCount});
          continue;
        }
        if (!e.replace_all && occurrences > 1) {
          results.push({op: i, ok: false, error: `old_string matches ${occurrences} times, use replace_all or add context`});
          break;
        }
        working = e.replace_all
          ? working.replaceAll(e.old_string, e.new_string)
          : working.replace(e.old_string, e.new_string);
        results.push({op: i, ok: true, matchCount: occurrences});
      }

      const failureIdx = results.findIndex(r => !r.ok);
      if (failureIdx >= 0) {
        const successes = failureIdx;
        return fail(`multi_edit: ${successes}/${edits.length} edits would succeed, but op ${failureIdx} failed: ${results[failureIdx].error}. No changes written. Re-read the file and retry.`);
      }

      // All validated — write
      await writeFile(filePath, working, 'utf-8');
      fileTracker?.recordRead(filePath); // post-write, we know the current state

      const summary = results.map((r, i) => `  op ${i}: ${r.matchCount} replacement(s)`).join('\n');
      return ok(`multi_edit: applied ${edits.length} edits to ${relative(process.cwd(), filePath)}\n${summary}`);
    },
  };
}
```

**Key decision:** Full rollback (write original back if anything fails) vs. validate-then-write (what I sketched). The sketch does validate-then-write: never writes a partial result, so there's nothing to roll back. This is simpler and matches crush's actual behavior.

**Factoring:** Extract the fuzzy-match logic from the existing `edit_file` into a shared `tryFuzzyEdit(content, oldStr, newStr, replaceAll)` helper so both tools use it.

**Validation:**
- Unit tests in `test/tools.test.ts`: 3 edits all valid → all applied; 3 edits with middle one broken → zero writes, clear error mentioning op index; edits where op 2 depends on op 1's output (e.g. rename variable then use it) → works because we apply in sequence to `working`.

**Risks:** Complexity vs. benefit for agents that already handle sequential `edit_file` calls. Worth it for large refactors.

---

## 5. Two-model split + semantic summarization

**Effort:** ~1 day.

**Why:** Current `ContextManager.compact()` in `src/context.ts` already does an LLM pass to refresh the KnowledgeState — but it uses the *current* model (large, slow). Crush splits into `models.large` (main coding) and `models.small` (summarization, cheap/fast), and runs summarization automatically on every compaction.

**Crush reference:** Crush's config has `models: {large: {...}, small: {...}}` at the top level. The summarizer runs on `models.small`. Replaces all pre-summary messages with one `IsSummaryMessage=true` message. On reload, the summary role flips to User.

**Port plan:**

1. **Config change** — add to `Config` in `src/config.ts`:
```typescript
export interface Config {
  // ...
  summarizerModel: string | null; // override for summarization; defaults to roster.chat
}
```
   Default `summarizerModel` to `null`, meaning "use roster.chat". Advanced users can pin.

2. **ContextManager changes** — in `src/context.ts`:
   - Add a `_summaryMessage: Message | null` field
   - Rewrite `compact()` to:
     a. Gather all messages older than the sliding window
     b. Call `summarizeIntoKnowledge()` (already exists) using **the summarizer model**, not `this.currentModel`
     c. Replace dropped messages with a single synthetic `{role: 'user', content: '[Context summary from earlier turns]: ...'}` message at the head of the window
     d. Keep this summary message across future compactions (it gets re-summarized if it grows too long)
   - The new `buildMessages()` prepends `_summaryMessage` before the sliding window

3. **Agent changes** — in `src/agent.ts`, pass `config.summarizerModel ?? this.roster?.chat ?? this.modelManager.getCurrentModel()` into `context.compact(host, summarizerModel)`.

4. **Summarizer prompt** — keep the existing structured KS format but *also* ask for a natural-language summary:
```
Here is the current knowledge state:
{currentState}

And here are the {n} messages being summarized out of the conversation:
{messages}

Output:
1. An updated knowledge state in the same KEY: [value | value] format
2. A one-paragraph natural-language summary of what happened in these messages (decisions made, files touched, current status)

Format:
KS:
PROJECT: ...
DECISIONS: [...]
...

SUMMARY:
<natural language paragraph>
```
   Parse both sections. The KS updates go into `knowledgeState`. The natural-language paragraph becomes the synthetic summary message content.

**Validation:**
- Unit test: feed 20 messages, compact, assert (a) KS has new decisions, (b) `_summaryMessage` is set, (c) `getMessages()` now returns `[summary, ...last 6]`.
- Integration: run a long session that crosses 80% context threshold and verify the completion badge shows a low enough token count after compaction.

**Risks:**
- Summarizer calls cost real tokens. They happen infrequently (only at compaction) so amortized cost is fine.
- Summary quality depends on `roster.chat` being decent. On very small models it might produce garbage. Mitigation: if the summarizer call fails or produces <50 chars, fall back to the existing regex-based KS update.

---

## 6. Skills catalog pattern

**Effort:** ~1-2 days.

**Why:** VEEPEE.md is injected *wholesale* into every system prompt today. Skills give you composable, on-demand instruction sets: a catalog with name+description lives in the prompt, bodies are loaded when the agent decides to "activate" one. Matches the [agentskills.io](https://agentskills.io) open standard and anthropics/skills library.

**Crush reference:** `/tmp/crush/internal/skills/skills.go` (236 LOC). The key insight I verified directly from the code: **only the catalog metadata** (name, description, location, builtin-flag) goes into the system prompt, not the full body. The agent sees:

```xml
<available_skills>
  <skill>
    <name>crush-config</name>
    <description>Configure Crush settings including providers, LSPs, MCPs, skills, permissions, and behavior options...</description>
    <location>crush://skills/crush-config/SKILL.md</location>
    <type>builtin</type>
  </skill>
</available_skills>
```

Then the agent, when it decides the skill is relevant, calls the view tool on the location to read the full body. Simple and token-efficient.

**SKILL.md format** — YAML frontmatter + markdown body:
```markdown
---
name: nextjs-14-migration
description: Step-by-step guide for migrating a Next.js 13 Pages Router app to Next.js 14 App Router. Use when the user mentions upgrading Next.js, migrating to App Router, or refactoring pages/ to app/.
---

# Next.js 14 Migration

1. Audit current pages/ structure...
```

Frontmatter rules: `name` must be kebab-case `[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*`, max 64 chars. `description` max 1024 chars. Invalid skills log a warning and are skipped, never fatal.

**Port plan:**

1. **New module** `src/skills.ts`:

```typescript
export interface Skill {
  name: string;
  description: string;
  path: string;       // absolute file path
  builtin: boolean;
}

const SKILL_PATHS = [
  // user-configurable via config.skillsPaths
  // also auto-scan these relative to cwd:
  '.veepee/skills',
  '.agents/skills',
  '.claude/skills',
  '.cursor/skills',
];

const GLOBAL_SKILL_PATHS = [
  // absolute paths
  `${process.env.HOME}/.veepee-code/skills`,
  `${process.env.XDG_CONFIG_HOME ?? process.env.HOME + '/.config'}/agents/skills`,
  `${process.env.XDG_CONFIG_HOME ?? process.env.HOME + '/.config'}/veepee-code/skills`,
];

export async function discoverSkills(extraPaths: string[] = []): Promise<Skill[]> {
  const seen = new Map<string, Skill>(); // name → skill (local overrides global)
  const paths = [...GLOBAL_SKILL_PATHS, ...SKILL_PATHS.map(p => resolve(process.cwd(), p)), ...extraPaths];

  for (const dir of paths) {
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      try {
        const content = await readFile(skillPath, 'utf-8');
        const skill = parseSkill(content, skillPath);
        if (skill) seen.set(skill.name, skill); // last wins (local paths come after global)
      } catch (err) {
        console.error(`[skills] failed to load ${skillPath}: ${err}`);
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function parseSkill(content: string, path: string): Skill | null {
  // Very simple YAML frontmatter parser (we already have zod, don't need a full yaml lib)
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^"|"$/g, '');
    fm[key] = val;
  }
  if (!fm.name || !fm.description) return null;
  if (!/^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/.test(fm.name)) return null;
  if (fm.name.length > 64 || fm.description.length > 1024) return null;
  return { name: fm.name, description: fm.description, path, builtin: false };
}

export function toPromptXML(skills: Skill[], disabled: Set<string>): string {
  const active = skills.filter(s => !disabled.has(s.name));
  if (active.length === 0) return '';
  const lines = ['\n<available_skills>'];
  for (const s of active) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(s.name)}</name>`);
    lines.push(`    <description>${escapeXml(s.description)}</description>`);
    lines.push(`    <location>${escapeXml(s.path)}</location>`);
    if (s.builtin) lines.push('    <type>builtin</type>');
    lines.push('  </skill>');
  }
  lines.push('</available_skills>\n');
  return lines.join('\n');
}
```

2. **Inject into system prompt** — in `src/context.ts` `rebuildSystemPrompt()`, add a `{{AVAILABLE_SKILLS}}` template variable and populate it from `toPromptXML(await discoverSkills(), disabledSet)`. Discovery happens once on startup and is cached on the `ContextManager` — re-run if a file watcher fires (optional).

3. **System prompt update** — add a paragraph explaining to the model:
   > You have access to a catalog of Skills below. Each skill is a reusable instruction set for a specific task. When a skill's description matches the user's request, read its full content using `read_file` on the skill's `<location>` before proceeding. Activate at most one or two skills per turn.

4. **Config**:
   - `config.skillsPaths: string[]` — extra discovery paths
   - `config.disabledSkills: string[]` — names to hide from the agent

5. **Builtin skill** — ship one bundled skill in `src/skills/builtin/veepee-config/SKILL.md` so users see the pattern. Content: "How to configure vcode.config.json, add providers, set up the remote bridge, etc." Embed via `fs.readFileSync` at build time or via a simple `import.meta.url` resolve.

6. **Existing Claude Code / Cursor compatibility** — by scanning `.claude/skills` and `.cursor/skills` we pick up anything the user already has from those tools. Free ecosystem interoperability.

**Validation:**
- Unit test: drop a fake skill at `/tmp/test-skills/my-skill/SKILL.md`, call `discoverSkills(['/tmp/test-skills'])`, assert returned array.
- Invalid frontmatter (bad name, missing description) → skipped, warning logged.
- Same skill name in global and local → local wins.
- `toPromptXML` snapshot test.

**Risks:** None major. Worth thinking about: should VEEPEE.md also become a "skill" with name `project-instructions`? Probably no — VEEPEE.md is always-on by design, skills are on-demand. Keep them separate.

---

## 7. Pub/sub permission broker

**Effort:** ~1 day.

**Why:** Current `PermissionManager.setPromptHandler(handler)` is a single injectable function, which forces conditional handler chains when both the TUI and RC are active. Crush uses a broker: tools call `Request(ctx, opts)` which publishes a `PermissionRequest` event and blocks on a response channel. Any number of subscribers (TUI, RC, API, future web UI) observe the same stream and can grant/deny.

**Crush reference:** `/tmp/crush/internal/permission/permission.go` (247 LOC). Uses `pubsub.Broker[PermissionRequest]` from their internal pubsub package. Key interface:

```go
type Service interface {
  pubsub.Subscriber[PermissionRequest]
  GrantPersistent(permission PermissionRequest)
  Grant(permission PermissionRequest)
  Deny(permission PermissionRequest)
  Request(ctx context.Context, opts CreatePermissionRequest) (bool, error)
  AutoApproveSession(sessionID string)
  SetSkipRequests(skip bool)  // --yolo
  SkipRequests() bool
  SubscribeNotifications(ctx context.Context) <-chan pubsub.Event[PermissionNotification]
}
```

**Port plan:**

1. **Refactor `src/permissions.ts`** to use an event emitter instead of a prompt handler:

```typescript
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  action: string;
  description: string;
  params: Record<string, unknown>;
  path?: string;
  reason?: string; // dangerous-pattern label
}

export type PermissionDecision = 'allow' | 'allow_always' | 'allow_project' | 'deny';

export class PermissionManager {
  private events = new EventEmitter();
  private pending = new Map<string, (d: PermissionDecision) => void>();
  private autoApproveSessions = new Set<string>();
  private skipAll = false; // --yolo
  // ... existing alwaysAllowed / sessionAllowed / projectAllowed fields

  /** Subscribe to permission requests. Return an unsubscribe fn. */
  onRequest(handler: (req: PermissionRequest) => void): () => void {
    this.events.on('request', handler);
    return () => this.events.off('request', handler);
  }

  /** Grant a pending request by id. */
  grant(id: string, scope: 'session' | 'always' | 'project'): void {
    const resolver = this.pending.get(id);
    if (!resolver) return;
    this.pending.delete(id);
    // also persist based on scope, reusing existing logic
    const decision: PermissionDecision =
      scope === 'always' ? 'allow_always' :
      scope === 'project' ? 'allow_project' :
      'allow';
    resolver(decision);
  }

  deny(id: string): void {
    const resolver = this.pending.get(id);
    if (!resolver) return;
    this.pending.delete(id);
    resolver('deny');
  }

  async check(toolName: string, args: Record<string, unknown>): Promise<PermissionDecision> {
    if (this.skipAll) return 'allow';
    // ... existing dangerous pattern + safe-tool + persisted checks ...
    // If prompt needed:
    const req: PermissionRequest = {
      id: randomUUID(),
      sessionId: '...',
      toolCallId: '...',
      toolName,
      action: '...',
      description: '...',
      params: args,
    };
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(req.id, resolve);
      this.events.emit('request', req);
      // 60-second timeout (matches RC behavior today)
      setTimeout(() => {
        if (this.pending.has(req.id)) {
          this.pending.delete(req.id);
          resolve('deny');
        }
      }, 60_000);
    });
  }
}
```

2. **TUI subscriber** — in `src/index.ts` after creating the TUI:
```typescript
const unsub = permissions.onRequest(async (req) => {
  // If RC clients are connected AND TUI is not focused, skip — RC will handle
  // Actually: let both fire, whichever user acts first wins
  const decision = await tui.promptPermission(req.toolName, req.params, req.reason);
  if (decision === 'y') permissions.grant(req.id, 'session');
  else if (decision === 'a') permissions.grant(req.id, 'always');
  else if (decision === 'p') permissions.grant(req.id, 'project');
  else permissions.deny(req.id);
});
```

3. **RC subscriber** — in `src/rc.ts`:
```typescript
permissions.onRequest((req) => {
  if (sseClients.length === 0) return; // no phone connected, let TUI handle
  broadcast('permission_request', req);
  // grant/deny handled by /rc/approve endpoint, calls permissions.grant(req.id, ...)
});
```

4. **`--yolo` CLI flag** → `permissions.setSkipAll(true)`. Print a big red warning on startup.

5. **Remove** the old `setPromptHandler` injection entirely. TUI and RC both become clean subscribers.

**Validation:**
- Unit test: fire a request, assert event listener gets called; call `grant`, assert promise resolves to `allow`.
- Timeout test: fire request, wait 61 seconds (or mock Date), assert auto-deny.
- Concurrent grants: two subscribers both respond, only the first one takes effect (second `grant` for same id is a no-op).

**Risks:** Medium-sized refactor. Coordinate with any in-flight permission work. Be careful not to break the existing `project`-scoped flow (item we just documented in `docs/permissions.md`).

---

## 8. MCP client support (stdio/http/sse)

**Effort:** ~2-3 days.

**Why:** The [Model Context Protocol](https://modelcontextprotocol.io) is the emerging standard for tool servers. VEEPEE Code's remote agent bridge is proprietary to Llama Rider. Adding MCP means instant access to the entire MCP ecosystem — filesystem-mcp, github-mcp, postgres-mcp, obsidian-mcp, brave-search-mcp, etc. — without writing per-integration code.

**Crush reference:** `/tmp/crush/internal/agent/tools/mcp/` — uses Go MCP library. Three transports: stdio (subprocess), http (one-shot requests), sse (streaming).

**Port plan:**

1. **Dependency** — add `@modelcontextprotocol/sdk` to `package.json`. It's the official SDK, has a good TypeScript client, supports all three transports.

2. **Config** — extend `Config`:
```typescript
export interface McpServerConfig {
  type: 'stdio' | 'http' | 'sse';
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse
  url?: string;
  headers?: Record<string, string>;
  // common
  timeout?: number; // seconds, default 120
  disabled?: boolean;
  disabled_tools?: string[];
}

export interface Config {
  // ...
  mcp: Record<string, McpServerConfig>;
}
```

3. **Env var expansion** — crush uses `$(echo $VAR)` and `$VAR` syntax in config values. Implement a simple expander that runs at config-load time: `$VAR` → `process.env.VAR`, `$(cmd)` → `execSync(cmd)` (limited to echo-style for safety).

4. **New module** `src/mcp.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export class McpManager {
  private clients = new Map<string, Client>();
  private serverNames = new Map<string, string>(); // toolName → serverName for disambiguation

  async connect(name: string, config: McpServerConfig): Promise<void> {
    if (config.disabled) return;
    let transport;
    switch (config.type) {
      case 'stdio':
        transport = new StdioClientTransport({ command: config.command!, args: config.args, env: config.env });
        break;
      case 'http':
        transport = new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: config.headers } });
        break;
      case 'sse':
        transport = new SSEClientTransport(new URL(config.url!), { requestInit: { headers: config.headers } });
        break;
    }
    const client = new Client({ name: 'veepee-code', version: '0.3.0' }, { capabilities: {} });
    await client.connect(transport);
    this.clients.set(name, client);
  }

  async listAllTools(): Promise<Array<{serverName: string, tool: Tool}>> {
    const all: Array<{serverName: string, tool: Tool}> = [];
    for (const [serverName, client] of this.clients) {
      const result = await client.listTools();
      for (const tool of result.tools) {
        all.push({ serverName, tool });
      }
    }
    return all;
  }

  async execute(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = this.clients.get(serverName);
    if (!client) return fail(`MCP server ${serverName} not connected`);
    const result = await client.callTool({ name: toolName, arguments: args });
    if (result.isError) return fail(JSON.stringify(result.content));
    return ok(result.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n'));
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
  }
}
```

5. **Tool registration** — in `src/index.ts` after local tool registration:
```typescript
const mcp = new McpManager();
for (const [name, cfg] of Object.entries(config.mcp)) {
  await mcp.connect(name, cfg).catch(err => console.error(`MCP ${name}: ${err}`));
}
const mcpTools = await mcp.listAllTools();
for (const {serverName, tool} of mcpTools) {
  if (config.mcp[serverName]?.disabled_tools?.includes(tool.name)) continue;
  // Convert MCP JSON Schema to Zod schema (reuse tools/remote.ts:buildZodSchema)
  const schema = buildZodSchema(tool.inputSchema);
  registry.register({
    name: tool.name, // no prefix, same namespace as native — like crush
    description: `[mcp:${serverName}] ${tool.description ?? ''}`,
    schema,
    execute: async (args) => mcp.execute(serverName, tool.name, args),
  });
}
```

6. **Decision: prefix or no prefix?** Crush uses no prefix. Pro: cleaner for the agent. Con: name collisions with native tools — VEEPEE Code currently has this fallback in `tools/remote.ts` (local wins). Follow the same rule: skip registering an MCP tool if a native or earlier-registered tool has the same name.

7. **Shutdown handling** — in `index.ts` cleanup, call `mcp.shutdown()` before `api.close()`.

8. **Wizard step** — add an `mcp` step to `src/wizard.ts` that lets the user configure one MCP server interactively. Or, defer — encourage direct `vcode.config.json` editing for MCP setup since the JSON is expressive.

**Validation:**
- Unit test: mock an MCP transport, register a fake tool, call it, assert result.
- Integration: `npx @modelcontextprotocol/server-filesystem /tmp` as a stdio MCP server, configure it in `vcode.config.json`, run `vcode /tools` and verify the filesystem tools appear.

**Risks:**
- Adds a real dependency (MCP SDK).
- Stdio transport spawns subprocesses — must track lifecycle to avoid zombie processes on crash.
- MCP tools can be slow; respect the `timeout` config.
- **Coexistence with remote bridge**: MCP and Llama Rider bridge are both tool sources. Register order: local → MCP → remote bridge. Document the priority.

---

## 9. Catwalk-style provider metadata registry

**Effort:** ~1-2 days. **Lower priority.**

**Why:** Today VEEPEE Code hardcodes `MODEL_CUTOFFS` in `context.ts` and infers capabilities from model names in `models.ts`. Crush fetches a live provider/model catalog from `https://catwalk.charm.sh` with etag-conditional-fetch, caches locally, falls back to embedded.

**For VEEPEE Code** this would mean: a curated Ollama-model metadata JSON (context window, cutoff date, tool support, code specialization, quantization notes) hosted somewhere (GitHub raw, a static endpoint). Updated once in a while. VEEPEE Code fetches on startup, caches locally, uses it to enrich `ModelProfile` beyond what `/api/tags` provides.

**Crush reference:** `/tmp/crush/internal/provider/` (search `config/provider.go` area) and the [catwalk](https://github.com/charmbracelet/catwalk) repo.

**Port plan:**

1. **Create `veepee-code-models` metadata file** — JSON schema:
```json
{
  "version": "2026-04-11",
  "models": [
    {
      "name_match": "qwen3-coder-next",
      "family": "qwen3",
      "cutoff": "2025-10",
      "capabilities": ["tools", "code", "thinking"],
      "default_ctx": 65536,
      "notes": "Best tool-calling score on the benchmark (2026-04-04)"
    },
    ...
  ]
}
```
Host it in the repo at `benchmarks/model-catalog.json` (gh raw URL). Or embed it and let users PR updates.

2. **`src/catalog.ts`**:
```typescript
export class ModelCatalog {
  private static CACHE = resolve(homedir(), '.veepee-code', 'model-catalog.json');
  private static EMBEDDED_PATH = resolve(fileURLToPath(import.meta.url), '../../model-catalog.json');
  private entries: CatalogEntry[] = [];

  async load(remoteUrl?: string): Promise<void> {
    // 1. Try remote with etag
    if (remoteUrl) {
      try {
        const etag = await this.readCachedEtag();
        const res = await fetch(remoteUrl, { headers: etag ? { 'If-None-Match': etag } : {} });
        if (res.status === 304) {
          this.entries = JSON.parse(await readFile(ModelCatalog.CACHE, 'utf-8')).models;
          return;
        }
        if (res.ok) {
          const data = await res.json();
          this.entries = data.models;
          await writeFile(ModelCatalog.CACHE, JSON.stringify(data));
          if (res.headers.get('etag')) await this.writeCachedEtag(res.headers.get('etag')!);
          return;
        }
      } catch { /* fall through */ }
    }
    // 2. Try local cache
    if (existsSync(ModelCatalog.CACHE)) {
      this.entries = JSON.parse(await readFile(ModelCatalog.CACHE, 'utf-8')).models;
      return;
    }
    // 3. Fall back to embedded
    this.entries = JSON.parse(await readFile(ModelCatalog.EMBEDDED_PATH, 'utf-8')).models;
  }

  enrichProfile(profile: ModelProfile): ModelProfile {
    for (const entry of this.entries) {
      if (profile.name.includes(entry.name_match)) {
        return {
          ...profile,
          capabilities: Array.from(new Set([...profile.capabilities, ...entry.capabilities])),
          contextLength: profile.contextLength || entry.default_ctx,
          family: entry.family || profile.family,
        };
      }
    }
    return profile;
  }
}
```

3. **Wire into `ModelManager.discover()`** — after building the initial profile list, `catalog.enrichProfile(p)` for each.

4. **CLI command** — `vcode update-catalog` force-refreshes from the remote.

5. **Replace `MODEL_CUTOFFS` in `context.ts`** — pull cutoff dates from the catalog instead of the hardcoded object.

**Validation:**
- Unit test: load a fixture catalog, enrich a profile, assert capabilities merged.
- Mock fetch with etag, assert second call uses `If-None-Match`.

**Risks:** Low. Worst case, fetch fails and embedded catalog is used. Lower priority than the other items because `/api/tags` + probe already covers most discovery needs.

**Open question:** Where to host the catalog? Options: a `gh-pages` branch of veepee-code, a dedicated repo, or just embed in the package and require git pulls to update. **Recommendation: embed in the package** to start — simplest, and the model world doesn't change that fast. Add remote fetch later if/when the catalog grows.

---

## 10. LSP diagnostics inlined into edit tool results ⭐️⭐️⭐️

**Effort:** **Weeks, not days.** This is the single biggest quality multiplier but also the largest piece of work. Deserves its own plan-mode design session before any code is written.

**Why:** When the agent calls `edit_file`, crush does:
1. `notifyLSPs(ctx, lspManager, filePath)` — opens file in running LSPs, sends `textDocument/didChange`, waits up to 5s for `textDocument/publishDiagnostics`
2. Formats the diagnostics into the tool response
3. Agent sees on the next turn:

```
<result>
Edited src/api.ts (+1 / -1 lines)
</result>

<file_diagnostics>
Error: src/api.ts:42:10 [gopls undefined] undefined: fmt.Prnitln
Warn: src/api.ts:50:5 [gopls unused] unused variable `x`
</file_diagnostics>

<project_diagnostics>
Error: src/other.ts:12:3 [tsc 2322] Type 'string' is not assignable to type 'number'
... and 3 more diagnostics
</project_diagnostics>

<diagnostic_summary>
Current file: 1 errors, 1 warnings
Project: 3 errors, 12 warnings
</diagnostic_summary>
```

This creates a tight feedback loop. The model writes → sees compile errors immediately → fixes in the next turn. For weak local models like Qwen/DeepSeek, this transforms "I hope this compiles" into "the tool told me it doesn't". It's the largest quality multiplier on the list.

**Crush reference:** `/tmp/crush/internal/lsp/` (1.5k LOC total) and `/tmp/crush/internal/agent/tools/diagnostics.go` (244 lines — key file, walked through in session). Key functions:
- `lsp.Manager` — lazy per-language client startup
- `openInLSPs(ctx, manager, filepath)` — non-blocking open (for read-only tools like `view`)
- `notifyLSPs(ctx, manager, filepath)` — open + notifyChange + **blocking** waitForDiagnostics (5s timeout). Used after edit/multiedit.
- `getDiagnostics(filePath, manager)` — collects diagnostics from all running clients, sorts by severity, formats as XML-tagged tool output
- `lsp_diagnostics` tool — standalone tool the agent can call to fetch diagnostics on demand
- `lsp_references` tool — find-references via LSP (faster and more accurate than grep for structured symbols)
- `lsp_restart` tool — restart an LSP server

**Port plan:** multi-phase.

### Phase A: Minimal LSP client + diagnostics-only

Goal: the agent can call a `diagnostics` tool and get structured errors from a single language server (start with TypeScript: `typescript-language-server`).

1. **Dependency** — add an LSP client library. Options:
   - `vscode-languageserver-protocol` + custom transport (lightweight, you write the stdio plumbing)
   - `vscode-jsonrpc` (lower level, more flexibility)
   - A full client like `ts-lsp-client` (less control)

   **Recommendation:** `vscode-languageserver-protocol` + `vscode-jsonrpc`. Official, well-maintained, minimal deps.

2. **New module `src/lsp/client.ts`** — wraps one LSP subprocess (single language):
   - `start(command, args)` — spawn server, initialize, handshake capabilities
   - `openFile(uri, content)` — send `textDocument/didOpen`
   - `notifyChange(uri, content)` — send `textDocument/didChange`
   - `waitForDiagnostics(uri, timeoutMs)` — return latest diagnostics for this URI, waiting up to timeout for a `textDocument/publishDiagnostics` notification
   - `getReferences(uri, line, col)` — `textDocument/references`
   - `getDefinition(uri, line, col)` — `textDocument/definition`
   - `getHover(uri, line, col)` — `textDocument/hover`
   - `shutdown()` — clean termination

   Key design: the client maintains an in-memory map `uri → Diagnostic[]` updated from server notifications. `waitForDiagnostics` returns when the map entry's version matches the last change sent, or after timeout.

3. **`src/lsp/manager.ts`** — one client per language:
   - `start(ctx, filePath)` — detects language from extension, lazily starts the right client
   - Maintains `Map<string, LspClient>` keyed by language
   - `getClientForFile(filePath)` — returns matching client or null
   - `shutdown()` — kills all clients on exit

4. **`src/lsp/config.ts`** — configurable LSP servers via `config.lsp`:
   ```typescript
   export interface LspConfig {
     command: string;
     args?: string[];
     filetypes?: string[]; // file extensions this server handles
     env?: Record<string, string>;
     enabled?: boolean;
     timeout?: number; // initialization timeout
   }
   
   export interface Config {
     // ...
     lsp: Record<string, LspConfig>; // key is language name
   }
   ```

   Example:
   ```json
   {
     "lsp": {
       "typescript": { "command": "typescript-language-server", "args": ["--stdio"], "filetypes": ["ts","tsx","js","jsx"] },
       "go": { "command": "gopls", "filetypes": ["go"] },
       "python": { "command": "pyright-langserver", "args": ["--stdio"], "filetypes": ["py"] }
     }
   }
   ```

5. **`src/lsp/diagnostics.ts`** — helpers to format diagnostics for agent consumption:
   - `formatDiagnostic(diag)` → `"Error: src/api.ts:42:10 [gopls E1234] unnecessary import"`
   - `formatDiagnostics(byFile)` → the full `<file_diagnostics>`/`<project_diagnostics>`/`<diagnostic_summary>` XML block crush produces
   - Sort order: errors before warnings before info, alphabetical within each group
   - Cap at 10 per section with `... and N more` suffix

6. **`notifyLSPs` helper** — in `src/lsp/index.ts`:
   ```typescript
   export async function notifyLSPs(manager: LspManager, filePath: string): Promise<void> {
     const client = manager.getClientForFile(filePath);
     if (!client) return;
     const content = await readFile(filePath, 'utf-8');
     await client.openFile(pathToUri(filePath), content);
     await client.notifyChange(pathToUri(filePath), content);
     await client.waitForDiagnostics(pathToUri(filePath), 5000);
   }
   ```

7. **New tool** `lsp_diagnostics` in `src/tools/lsp.ts`:
   ```typescript
   function createLspDiagnosticsTool(lspManager: LspManager): ToolDef {
     return {
       name: 'lsp_diagnostics',
       description: 'Get LSP diagnostics (errors, warnings) for a file or the whole project. Use this to check for compile/type errors after editing.',
       schema: z.object({
         path: z.string().optional().describe('File path, or omit for project-wide'),
       }),
       execute: async (params) => {
         if (params.path) {
           await notifyLSPs(lspManager, resolve(params.path as string));
         }
         const output = formatDiagnostics(lspManager.getAllDiagnostics(), params.path as string | undefined);
         return ok(output || 'No diagnostics reported.');
       },
     };
   }
   ```

8. **Register in `index.ts`** — after tool registration:
   ```typescript
   const lspManager = new LspManager(config.lsp ?? {});
   for (const tool of registerLspTools(lspManager)) registry.register(tool);
   ```

### Phase B: Inline diagnostics in edit results

Once phase A is stable, wire `notifyLSPs` + `formatDiagnostics` into the existing `edit_file` and `write_file` tools. Pass `lspManager` down to `registerCodingTools`.

```typescript
// inside edit_file execute() after the writeFile succeeds:
await notifyLSPs(lspManager, filePath);
const diags = formatDiagnostics(lspManager.getAllDiagnostics(), filePath);
const responseText = `<result>\n${editSummary}\n</result>\n${diags}`;
return ok(responseText);
```

This is where the quality multiplier kicks in. Every edit → immediate feedback.

### Phase C: `lsp_references` tool

Add a `lsp_references` tool for precise find-usages:
```typescript
{
  name: 'lsp_references',
  description: 'Find all references to a symbol at a specific file location using LSP. More accurate than grep for structured symbols.',
  schema: z.object({
    path: z.string(),
    line: z.number().describe('1-based line number'),
    character: z.number().describe('0-based column'),
  }),
}
```
Calls `client.getReferences` and returns a formatted list.

### Phase D: Non-blocking `view` integration

In `read_file` tool, after reading, optionally call `openInLSPs` (non-blocking) so the server knows about the file. Doesn't wait for diagnostics — that's what `edit_file` does.

### Validation per phase

- **A**: Unit test with a fake LSP server (or skip and go integration): drop a file with a deliberate error, call `lsp_diagnostics`, assert the error appears in the output.
- **B**: Create a `.ts` file, call `edit_file` to introduce a type error, verify the tool response contains `<file_diagnostics>` with the error.
- **C**: Test `lsp_references` on a known symbol in the veepee-code repo itself.
- **D**: Verify `read_file` doesn't block on LSP startup.

### Risks and considerations

- **LSP servers are heavyweight.** Each `typescript-language-server` eats ~300MB. Lazy-start is essential.
- **Cold start latency.** First `edit_file` call pays the LSP init cost (5-15s for TS). Either: (a) start LSP on session open based on project detection (if `tsconfig.json` exists, warm up `typescript-language-server`), or (b) show a "warming up LSP" thinking event in the TUI.
- **LSP server bugs.** Some servers misbehave, hang, or OOM. Wrap client calls in timeouts and log failures. The `lsp_restart` tool from crush is worth porting for recovery.
- **Multi-root workspaces.** Crush handles this; we should too if we care about monorepos. Defer for v1.
- **Windows paths.** URIs must be properly encoded (`file:///C:/foo/bar.ts`). Use a helper.
- **Shutdown.** LSP servers must be killed cleanly on exit or they become zombies. Hook into the existing cleanup in `index.ts`.
- **Diagnostic volume.** A fresh `tsc --noEmit` on a large codebase can return hundreds of errors. Crush caps at 10 per section. Follow the same policy.

### Pre-work before starting

Before writing code for item 10, run a **plan-mode design session** that:
1. Picks the LSP client library (validate it actually works with `typescript-language-server`, `gopls`, `pyright`)
2. Decides on the client → manager → tool ownership chain
3. Designs the error recovery / restart story
4. Defines the config schema for the `lsp` block
5. Writes a ~200-line design doc under `docs/plans/v0.4-lsp.md` (follow-on to this doc)

---

## B1: Reflective JSON Schema export

**Effort:** ~½ day. Quality-of-life for anyone editing `vcode.config.json` by hand.

**Why:** Crush generates its config JSON Schema from the Go `Config` struct via reflection, so the schema stays in sync with code automatically. VEEPEE Code uses Zod in `src/tools/types.ts` already. We can define `Config` as a Zod schema and use `zod-to-json-schema` to emit a JSON Schema users point `$schema` at.

**Port plan:**

1. Add `zod-to-json-schema` to `package.json`.

2. Define Config as a Zod schema in `src/config.ts`:
```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ConfigSchema = z.object({
  proxyUrl: z.string().url().default('http://localhost:11434'),
  dashboardUrl: z.string().default(''),
  model: z.string().nullable().default(null),
  autoSwitch: z.boolean().default(true),
  maxModelSize: z.number().default(40),
  minModelSize: z.number().default(12),
  apiPort: z.number().default(8484),
  apiHost: z.string().default('127.0.0.1'),
  apiToken: z.string().nullable().default(null),
  apiExecute: z.boolean().default(false),
  searxngUrl: z.string().url().nullable().default(null),
  // ... all fields ...
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path?: string): Config {
  const raw = /* load file */;
  return ConfigSchema.parse(raw); // validation for free
}
```

3. New CLI command `vcode schema` — prints the JSON Schema to stdout:
```typescript
if (process.argv.includes('schema')) {
  const schema = zodToJsonSchema(ConfigSchema, { name: 'VcodeConfig' });
  console.log(JSON.stringify(schema, null, 2));
  process.exit(0);
}
```

4. Users add `"$schema": "https://raw.githubusercontent.com/vpontual/veepee-code/main/vcode.config.schema.json"` to their config. Run `npm run build:schema` during CI to regenerate.

5. IDE autocomplete (VS Code, IntelliJ) works automatically once `$schema` is set.

**Side benefit:** `ConfigSchema.parse(raw)` replaces the current ad-hoc `loadConfig()` merging logic with real validation. Invalid configs fail loudly with zod error messages.

**Validation:** Unit test `ConfigSchema.parse()` with valid and invalid inputs. Snapshot test on the generated JSON Schema.

---

## Sequencing summary

| Order | Item | Effort | Rationale |
|-------|------|--------|-----------|
| 1 | Hash-sig loop detection | 30min | Free win |
| 2 | File staleness check | ½ day | Safety, low effort |
| 3 | `agent` tool (subagent) | 1h | Unlocks dead code |
| 4 | Multi-edit | ½ day | Enables atomic refactors |
| 5 | Two-model split + summarization | 1 day | Long-session quality |
| 6 | Skills catalog | 1-2 days | Ecosystem interop |
| 7 | Pub/sub permissions | 1 day | Cleaner shape, enables parallel UIs |
| 8 | MCP client | 2-3 days | Instant access to MCP ecosystem |
| 9 | Catalog | 1-2 days | Lower priority, embed first |
| 10 | LSP (Phase A minimum) | weeks | **Biggest quality gain** — dedicated plan session first |
| B1 | JSON Schema export | ½ day | Polish, do alongside anything |

Total for items 1-9: roughly **1-2 weeks** of focused work. Item 10 is its own thing.

**Milestone suggestion:** tag v0.4.0 after items 1-7 (quick wins + skills + permissions broker). Tag v0.5.0 after MCP (item 8). Tag v0.6.0 after LSP (item 10). Phase plan-mode design session for v0.5 and v0.6 before committing.

---

## Open questions to resolve

1. **LSP library choice** — verify `vscode-languageserver-protocol` + `vscode-jsonrpc` actually work headlessly with `typescript-language-server` and `gopls`. Prototype before committing.
2. **Skills bundling** — do we ship builtin skills in the npm package, embed as strings, or copy to `~/.veepee-code/skills/builtin/` on first run?
3. **MCP + remote bridge ordering** — when both are configured, what's the priority chain? Proposed: local tools → MCP → remote bridge (most specific wins).
4. **Summarization model default** — if `roster.chat` isn't set (small fleet, only one model), fall back to... what? Current model? Skip summarization? Warn?
5. **Schema hosting URL** — once `vcode.config.schema.json` is committed to the repo, what URL do we tell users to use? GitHub raw is fine but fragile if repo moves. Alternative: a stable redirect.
6. **LSP lazy-start trigger** — start on first `read_file` for a matching extension, or proactively on session start based on project detection (`tsconfig.json` → start TS server)?

These can be answered as each item gets implemented.

---

## References

- **Crush repo** (cloned to `/tmp/crush` during analysis session): https://github.com/charmbracelet/crush
- **Agent Skills standard**: https://agentskills.io
- **MCP spec**: https://modelcontextprotocol.io
- **Anthropic skills library**: https://github.com/anthropics/skills
- **Catwalk (crush provider registry)**: https://github.com/charmbracelet/catwalk
- **VEEPEE Code memory file**: `~/.claude/projects/-home-vp-Dev/memory/veepee-code-project.md`
- **Synthesis discussion**: the Claude Code session from 2026-04-11 where this plan was drafted.
