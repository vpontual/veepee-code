---
title: "Modes"
description: "Five operating modes: act, plan, chat, and MoE -- how they work, roster-based model selection, effort levels, and when to use each."
weight: 4
---

# Modes

VEEPEE Code has four operating modes, each optimized for a different workflow. Each mode uses its roster-assigned model (from the first-launch benchmark). Switch between them with slash commands, or let the agent auto-detect planning intent.

## /act -- Execution Mode (Default)

Act mode is the default. The agent reads, writes, and executes -- getting things done with minimal overhead.

**Characteristics:**
- **Thinking:** OFF -- the model generates output directly without explicit reasoning steps
- **Model:** Uses the roster's **act** model (best overall with decent speed). Auto-switching enabled -- the agent can upgrade to a heavier model for complex tasks.
- **Tools:** All registered tools available
- **Behavior:** Execute first, explain after. The agent calls tools proactively and gives concise answers.

**Best for:**
- Writing and editing code
- Running builds, tests, and deployments
- File system operations
- Quick questions about your codebase
- Any task where you want the agent to just do the work

**Example:**

```
> Fix the TypeScript error in src/api.ts

  ◆ read_file path=src/api.ts
  ✓ (45 lines)
  ◆ edit_file path=src/api.ts old_string="..." new_string="..."
  ✓ Edited src/api.ts: -1 +1 lines

Fixed the type mismatch on line 23 -- `string` should be `string | undefined`.
```

## /plan -- Planning Mode

Plan mode activates deep thinking. The agent reasons through problems before acting, asks clarifying questions, and presents a step-by-step plan for your approval.

**Characteristics:**
- **Thinking:** ON -- the model uses `<think>` tags (Qwen, DeepSeek) or native thinking (via the `think` API parameter) to reason through decisions. Thinking blocks are displayed collapsed in the TUI.
- **Model:** Uses the roster's **plan** model (best reasoning score). If no roster exists, falls back to the heaviest model with thinking support. Auto-switching is disabled (locked to the plan model).
- **Tools:** All registered tools available, but the agent prefers reading and exploring over writing.
- **Behavior:** Asks clarifying questions before acting. Presents numbered plans with rationale. Waits for explicit approval before implementing.

**Best for:**
- Architecture decisions ("How should I structure the auth system?")
- Complex refactoring that touches many files
- Debugging difficult issues
- Evaluating tradeoffs between approaches
- Any task where the cost of getting it wrong is high

**Example:**

```
/plan
> Design the database schema for multi-tenant support

  ◐ Thinking...
  ◆ glob pattern="**/*.ts"
  ✓ Found 47 files
  ◆ read_file path=src/db/schema.ts
  ✓ (120 lines)
  ◆ web_search query="multi-tenant database patterns PostgreSQL 2026"
  ✓ 5 results

Before implementing, here are some questions:

1. Do you need **row-level** (shared tables with tenant_id) or **schema-level** (separate schema per tenant) isolation?
2. How many tenants do you expect? 10? 10,000? 1M?
3. Does any tenant data need to be queryable across tenants (e.g., analytics)?

Based on your current schema, here's my recommended approach:

**Plan:**
1. Add a `tenant_id` column to all user-facing tables...
2. Create a Row-Level Security policy...
3. ...

Should I proceed with this plan?
```

### Auto-Detection of Planning Intent

When in act mode, VEEPEE Code watches for planning-intent signals in your messages and automatically switches to plan mode. These patterns trigger auto-detection:

- "plan", "design", "architect", "strategy"
- "think about", "think through"
- "brainstorm", "approach"
- "how should we...", "how would I...", "how could you..."
- "before we start/begin/implement/code/build"
- "what's the best way to..."
- "break this down", "step by step"
- "deepen", "elaborate", "expand on"
- "let's think", "consider"

When auto-detected, you will see a model switch notification:

```
  ◐ Model: qwen3:8b → qwen3.5:35b (Entering plan mode)
```

To return to act mode: type `/act`.

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

The `/effort` command controls how much work the agent puts into each response. Effort levels work across all modes (act, plan, chat, and MoE).

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

| Feature | /act (default) | /plan | /chat | /moe |
|---------|---------------|-------|-------|------|
| Thinking | OFF | ON | OFF | OFF |
| Model source | Roster: act | Roster: plan | Roster: chat | 3 models (parallel) |
| Auto-switch | Yes | No | No | No |
| All tools | Yes | Yes | No (web only) | Yes |
| File access | Yes | Yes | No | Yes |
| Shell commands | Yes | Yes | No | Yes |
| Web search | Yes | Yes | Yes | Yes |
| Behavior | Execute first | Think first | Converse | Multi-model synthesis |
| Default | Yes | No | No | No |

## Switching Modes

```
/plan       # Enter plan mode
/act        # Return to act/execution mode
/chat       # Enter chat mode
/moe        # Enter mixture of experts mode
/effort low|medium|high  # Set effort level (works in any mode)
```

When you switch back to `/act` from plan, chat, or MoE mode:
- The roster's act model is restored (or the previous model if no roster exists)
- Auto-switching is re-enabled
- The system prompt is rebuilt for execution mode

Mode state is maintained for the session -- it does not persist across restarts (though sessions saved with `/save` record the active mode). Effort level also persists for the session.
