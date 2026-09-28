---
title: "Modes"
description: "Act 1, Act 2 and Chat (cycled with Shift+Tab), the /verify hold, MoE, effort levels, and when to use each."
weight: 4
---

# Modes

VEEPEE Code has three everyday modes — **Act 1**, **Act 2** and **Chat** — which **Shift+Tab** cycles in that order, naming the model each time. Separately, **`/verify`** holds any change until you approve it, and **`/moe`** asks three models at once.

```
⇥ Act 2 · gemma4:26b-a4b
```

There is no plan mode any more (retired 2026-09-28). It bundled three things — a different model, a prompt, and a read-only gate — that are now separate: the other model is `/act 2`, and the gate is `/verify`. Current models plan on their own when a task needs it; `todo_write` keeps the steps.

## /act 1 -- the primary model (default)

Act is where work happens: the agent reads, writes and runs things.

- **Model:** your primary model (`lockModel` / `model`, or the one auto-selected at startup). A `/model` choice made in Act 1 is what Act 1 comes back to after Act 2 or Chat.
- **Thinking:** ON — Qwen3.6 needs it for reliable tool use.
- **Tools:** everything registered, under your `/permissions` setting.
- **Behaviour:** execute first, explain after. The nudges (act-don't-narrate, verify-after-edit, finish-the-task-list) run here.

```
> Fix the TypeScript error in src/api.ts

  ◆ read_file path=src/api.ts
  ✓ (45 lines)
  ◆ edit_file path=src/api.ts old_string="..." new_string="..."
  ✓ Edited src/api.ts: -1 +1 lines
```

## /act 2 -- the second model

The same act mode on a different model, for a second opinion or when the primary is busy or down.

- **Model:** `secondModel` in settings.json, else the first of `fallbackModels`. (`planModel`, the old name, is still read.) With neither set, Act 2 is skipped by Shift+Tab and `/act 2` says how to configure it.
- It is switched to by name and needs no discovered profile, so it works on a `lockModel` install; a model the direct server does not serve is routed through the gateway.
- Everything else is as Act 1.

`/act` on its own returns to whichever act slot you were last on.

## /verify -- read-only until you approve

Off by default; toggled with `/verify` (or `/verify on|off`). It works in any mode and on either model, and shows as `· verify` beside the mode.

While it is on:

- Only read-only tools run: reading, search, grep, LSP, web search/fetch, read-only git, GET requests and the task list.
- Everything else — edits, shell (even a command that would normally just prompt, like `rm -rf`), git writes, GitHub, MCP tools and subagents, including ones already running in the background — is **refused with a reason the model can read** ("held: verify is on… call request_approval"). The tools stay visible: an older plan mode hid them, and the model — unable to see bash — rebuilt a script's output with ~50 read-only calls instead of saying it could not run it.
- When it knows what to do, the model calls `request_approval` with a concrete proposal. You see it in the normal approval prompt. **Approve and verify turns off**; reject and it stays on for a revised proposal.
- An "always" answer to that prompt is not remembered — every proposal is asked.

Use it for changes where getting it wrong is expensive: schema migrations, multi-file refactors, anything touching production.

## /permissions -- how much to ask

Unchanged in meaning, moved off Shift+Tab:

```
/permissions manual   # ask before anything that is not read-only (default)
/permissions edits    # file edits go through; bash still asks
/permissions auto     # everything except rm -rf / force-push / reset --hard
/permissions          # show the current setting and what is allowed
```

## /chat -- Conversational Mode

Chat mode is for casual conversation with web access. No file editing, no shell commands -- just a knowledgeable assistant that can search the web.

**Characteristics:**
- **Thinking:** OFF
- **Model:** Uses the roster's **chat** model (fastest with good instruction following). If no roster exists, falls back to a fast standard-tier model. Auto-switching is disabled.
- **Tools:** Limited to `web_search`, `web_fetch`, `http_request`, `weather`, and `news`. No file access, no shell, no git.
- **Behavior:** Proactively searches the web for current information. Cites sources. Conversational tone.

**Best for:**
- Looking up documentation or API changes
- Current events and news
- General knowledge questions
- Comparing technologies or approaches
- Quick weather or news checks
- Any question where you want conversation, not code changes

**Example:**

```
/chat
> What changed in React 19?

  ◆ web_search query="React 19 new features changes 2025"
  ✓ 5 results
  ◆ web_fetch url="https://react.dev/blog/..."
  ✓ (article content)

According to the React 19 release blog:

- **React Compiler** is now stable -- automatic memoization
- **Server Components** are the default rendering strategy
- **Actions** replace form handling patterns...
```

## /moe -- Mixture of Experts Mode

MoE mode queries 3 models in parallel and combines their responses using an automatically detected strategy. This produces higher-quality answers by leveraging the strengths of different models.

**Characteristics:**
- **Models:** 3 models queried simultaneously (typically spanning heavy, standard, and light tiers)
- **Strategy:** Auto-detected from the query type:
  - **synthesize** -- combines the best parts of all responses into a unified answer (default for most queries)
  - **debate** -- presents each model's perspective with a final verdict (for opinion/tradeoff questions)
  - **vote** -- takes the majority answer (for factual/deterministic questions)
  - **fastest** -- returns whichever model responds first (for simple or time-sensitive queries)
- **Thinking:** OFF (each sub-model runs without thinking; the synthesis step handles reasoning)
- **Tools:** All registered tools available to each sub-model
- **Behavior:** Higher latency (waits for all 3 models), but noticeably better quality on complex or ambiguous questions

**Best for:**
- Architecture decisions where you want multiple perspectives
- Code review with diverse model strengths
- Ambiguous questions where a single model might guess wrong
- Any task where quality matters more than speed

**Example:**

```
/moe
> What's the best way to handle auth tokens in a Next.js 16 app?

  ◆ Querying 3 models in parallel...
  ◆ Strategy: synthesize (auto-detected)

  Model 1 (qwen3.5:35b): httpOnly cookies with middleware refresh...
  Model 2 (qwen3:8b): server-side session with encrypted cookie...
  Model 3 (llama3.2:8b): NextAuth.js with JWT strategy...

  Synthesized answer:
  The recommended approach combines httpOnly cookies for token storage
  (Model 1) with middleware-based refresh (Model 1) and NextAuth.js
  as the auth framework (Model 3)...
```

## Effort Levels

The `/effort` command controls how much work the agent puts into each response. Effort levels work across all modes (Act 1, Act 2, Chat and MoE).

```
/effort low        # Minimal -- short answers, fewer tool calls, skip exploration
/effort medium     # Balanced -- default behavior (this is the default)
/effort high       # Thorough -- deeper exploration, more tool calls, longer answers
```

| Level | Behavior |
|-------|----------|
| **low** | Concise answers, minimal tool usage, skips non-essential exploration. Good for quick questions or when you already know roughly what you want. |
| **medium** | Default balance of thoroughness and speed. The agent explores as needed and gives reasonably detailed answers. |
| **high** | Maximum thoroughness. The agent reads more files, considers more edge cases, and gives comprehensive answers. Good for complex debugging or architecture work. |

Effort level persists for the session. It does not affect model selection -- only how aggressively the agent explores and how detailed its responses are.

## Mode Comparison

| Feature | Act 1 (default) | Act 2 | Chat | /moe |
|---------|-----------------|-------|------|------|
| Model | primary | `secondModel` / first fallback | roster: chat | 3 models (parallel) |
| Thinking | ON | ON | OFF | OFF |
| All tools | Yes | Yes | No (web only) | Yes |
| `/verify` applies | Yes | Yes | n/a (nothing to hold) | — |
| Default | Yes | No | No | No |

## Switching Modes

```
Shift+Tab   # Act 1 -> Act 2 -> Chat -> Act 1, naming the model
/act 1      # primary model
/act 2      # second model
/act        # back to the act slot you were last on
/chat       # chat mode
/verify     # toggle the read-only hold (any mode)
/moe        # mixture of experts
/effort low|medium|high  # works in any mode
```

Mode state lasts for the session; it does not persist across restarts.
