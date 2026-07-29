---
title: "Harness Evaluation"
description: "Measure vcode itself — run the real agent against graded coding tasks and compare harness changes."
weight: 15
---

# Harness Evaluation

`vcode --eval` scores **the harness**, not the model.

`/benchmark` answers "how good is this model at writing a debounce function". Useful, but it drives `ollama.chat` with its own loop, so it tells you nothing about vcode. The harness — context management, tool design, the force-act and force-verify nudges, compaction thresholds, effort budgets, permission flow — is at least as large a lever on real coding performance, and until now nothing measured it. Every change to the agent loop was unfalsifiable: it felt better, or it didn't.

This runs the **real `Agent`** with the **real tool registry** against tasks that only pass if it reads existing code, edits several files, runs the tests, and fixes what it broke.

## Usage

```bash
vcode --eval                       # Run every task
vcode --eval fix-failing-test      # Run one task by name
vcode --eval debug                 # Run every task carrying a tag
vcode --eval --json                # Also emit the full result to stdout
```

Output:

```
Harness eval — Qwen/Qwen3.6-35B-A3B-FP8
2 task(s) available

[1/2] extend-existing-pattern: FAIL (40s, 15 tool calls)
[2/2] fix-failing-test: PASS (26s, 12 tool calls, self-verified)

Score: 50% (1/2)  @ ce18a49
```

Every run is saved to `~/.veepee-code/harness-evals/<timestamp>-<commit>.json`. That is the point: results are keyed by the commit the harness was at, so "did this change help?" becomes a diff instead of an opinion.

## Metrics

Beyond pass/fail, each task records:

| Metric | Why it matters |
|---|---|
| `toolCalls` | How much work the harness needed to get there |
| `toolErrors` | Tool calls that failed. A high count means the harness is fighting itself — bad tool descriptions, bad argument schemas, or a model that cannot drive them |
| `selfVerified` | Whether the agent ran the tests **unprompted**. The force-verify nudge exists to make this true; this is how you find out if it works |
| `turns` | Loop iterations |
| `wallMs` | Wall clock, which on a self-hosted fleet is the only real budget |

## Writing a task

```
benchmarks/harness/<name>/
  task.md          The instruction handed to the agent, verbatim
  workspace/       Seed files, copied into a scratch directory
  verify.test.ts   The grading test
  metadata.json    { "tags": [...], "timeout_ms": 420000 }
```

Two rules make a task worth having:

**1. The grading test must be introduced only after the agent finishes.** `verify.test.ts` is copied in at grading time, so it cannot be read or edited. An agent that "fixes" a failing suite by rewriting the visible test still fails.

**2. The grading test must be broader than the visible one.** Check the conventions, not just the happy path. `extend-existing-pattern` asks for a new migration operation and grades the validation rules and the exported registry — so a model that adds a plausible render branch without reading how the existing operations work fails, which is exactly the behaviour worth catching.

Always confirm a new task's grader **fails on the untouched workspace**. A grader that cannot fail scores nothing.

## How a task is run

1. The task's `workspace/` is copied to a scratch directory in `/tmp`.
2. A real `Agent` is built with the same tools the CLI registers, rooted there. Permissions are auto-allowed — there is no human to prompt, which is also why this only ever runs against a throwaway copy.
3. The agent runs the prompt until it finishes or hits the task timeout.
4. The workspace is copied to a grading directory, `verify.test.ts` is added, and vitest runs.

MCP servers, remote-bridge tools and skills are deliberately excluded: they depend on the machine and the network, and including them would make scores incomparable between runs.

### Two details that were wrong at first, and matter

**Grading runs inside the repository, not in `/tmp`.** vitest's config imports `vitest/config`, which Node resolves by walking up from the config file — from `/tmp` that finds nothing and vitest dies before running a single assertion. At the exit-code level that is indistinguishable from a real failure, so grading silently depended on whether the agent had happened to run `npm install`. The grading copy now lives under the repo so `node_modules` resolves normally.

**The eval registers the same toolset as the CLI.** An earlier version registered only the coding and devops groups; the model promptly hallucinated a `syntax` tool, called it ten times and was stopped by loop detection — a failure caused entirely by the eval. An eval that runs a different toolset measures a different harness.

## Agent errors vs. grading failures

These are reported differently and must not be conflated:

```
FAIL  fix-failing-test  1s  0 calls, 0 errors
      agent error: model 'Qwen/Qwen3.6-35B-A3B-FP8' not found on any available server
```

"The fleet was down" and "the model wrote the wrong code" are completely different results. A 0% score with an agent error in every task is an infrastructure problem, not a regression.
