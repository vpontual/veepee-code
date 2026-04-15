---
title: "Benchmarking"
description: "Execution-based code-gen, multi-turn edits, regression tests, replay corpus, and role-based model roster."
weight: 7
---

# Benchmark

The vcode benchmark measures Ollama models across five signal categories plus a negative-control discrimination check. It is designed as a **filter**, not a **ranker** — use it to rule out obviously-broken models, then verify any promotion candidate with the replay corpus.

> **Core lesson** (ported from Llama Rider's 48-hour rebuild): aggregate benchmark scores do not reliably predict production. Execution-based ground truth + real-traffic replay + failure-mode regression tests are what actually work. See [`benchmark-improvement-plan.md`](./benchmark-improvement-plan.md) for the full rationale.

## What the benchmark measures

| Category | Source of truth | Category weight |
|---|---|---|
| Tool calling | 4 synthetic tests incl. a 12-tool discrimination test, hallucinated-tool gate | 30% |
| Code generation | `benchmarks/exercises/` — real vitest pass rate | 25% |
| Code editing | `benchmarks/multiturn/` — multi-turn edit sessions, final-state vitest | 15% |
| Instruction following | Format constraints + streaming endurance + REG-002 | 15% |
| Reasoning | Counter-factual, multi-hop planning, constraint satisfaction, classic multi-step | 15% |

Plus:

- **Tool-name validity gate (P3)** — any call to a name not in `benchmarks/tool-registry.json` ∪ per-test synthetic tools fails that test instantly.
- **Regression tests (P4)** — triple-weighted failures frozen from real incidents, loaded from `benchmarks/regressions/*.jsonl`.
- **Speed floors (P6)** — roster role selection enforces per-role minimum tok/s: `chat=15`, `search=15`, `act=10`, `code=10`, `plan=2`.
- **Negative-control check (P5)** — if any model in `benchmarks/negative-controls.json` ranks top-3, the benchmark is not discriminating and prints a warning.

## Running

```sh
# Full benchmark against all models on the proxy
npm run dev -- benchmark

# Only heavy-tier models
npm run dev -- benchmark heavy

# Single model (fastest way to smoke-test)
npm run dev -- benchmark --only qwen3-coder:30b
```

Results go to `~/.veepee-code/benchmarks/latest.json` plus a timestamped history file.

## Directory layout

```
benchmarks/
├── tool-registry.json        # Built-in tool names (regenerate after adding/renaming)
├── negative-controls.json    # Deliberately-weak models for discrimination check
├── exercises/                # P0: execution-based code-gen
│   └── <name>/
│       ├── problem.md
│       ├── starter.ts (optional)
│       ├── expected.test.ts
│       └── metadata.json
├── multiturn/                # P1: multi-turn edit sessions
│   └── <name>/
│       ├── turns.json        # { "turns": ["user message 1", "user message 2", ...] }
│       ├── expected.test.ts
│       └── metadata.json
├── regressions/              # P4: frozen production failures
│   └── REG-*.jsonl           # one JSON record per line
├── corpus/                   # P2: real-traffic replay
│   ├── latest.jsonl          # written by scripts/extract-corpus.ts
│   └── replay-*.json         # written by scripts/replay-corpus.ts
├── predictions/              # P5: pre-registered ranking guesses
│   ├── TEMPLATE.md
│   └── <YYYY-MM-DD>.md       # stamp via scripts/new-prediction.ts
└── scratch/                  # per-run working dirs for exercises (auto-cleaned)
```

## Adding tests

### Adding an execution-based exercise (P0)

```sh
mkdir benchmarks/exercises/my-new-exercise
# Write problem.md (user-facing prompt), expected.test.ts (vitest), metadata.json
```

Exercises run in an isolated scratch dir with `write_file`/`read_file`/`edit_file`/`list_files`/`shell` scoped to that dir. The model's solution is graded solely on whether `expected.test.ts` passes. Binary pass/fail — no partial credit.

### Adding a multi-turn test (P1)

Same structure as exercises, but with `turns.json` instead of `problem.md`:

```json
{
  "description": "...",
  "turns": [
    "First user message",
    "Second user message building on the first",
    "Third user message"
  ]
}
```

Each turn runs an agent loop to completion before the next turn starts. `expected.test.ts` runs against the final state — it validates that **all** turns' requirements are preserved, not just the last one.

### Adding a regression test (P4)

When production fails, freeze the triggering input as a permanent regression:

```
benchmarks/regressions/REG-00N.jsonl
```

```json
{
  "id": "REG-00N",
  "date": "YYYY-MM-DD",
  "description": "What failed and why",
  "user_message": "exact triggering prompt",
  "tools": [ /* optional: test-local tool schemas */ ],
  "failure_criterion": { "type": "no_hallucinated_tool" },
  "weight": 3
}
```

Supported `failure_criterion.type`:

- `no_hallucinated_tool` — no tool call with a name outside `tool-registry.json ∪ test.tools`
- `correct_tool` — first tool call's name equals `.tool`
- `min_response_length` — response ≥ `.min_chars` (catches stream drops)
- `contains` — response contains every string in `.substrings` (case-insensitive)

### Regenerating the tool registry

```sh
npx tsx scripts/generate-tool-registry.ts
```

Run after adding, renaming, or removing any tool in `src/tools/`.

## Real-world test sources

Three complementary ground-truth sources, in order of increasing repo-specificity. Run all three before promoting.

### Source A — Aider polyglot-benchmark (industry-standard execution tests)

One-time import of TypeScript problems from [Aider's polyglot-benchmark](https://github.com/Aider-AI/polyglot-benchmark) (Apache 2.0, ~225 problems with real vitest suites). After import, the exercises loader in `src/benchmark-exercises.ts` picks them up automatically alongside the hand-written seed set — Aider entries are name-prefixed `aider-*` to avoid collisions.

```sh
# One-time import (rerun to refresh)
git clone https://github.com/Aider-AI/polyglot-benchmark /tmp/polyglot-benchmark
npx tsx scripts/fetch-aider-polyglot.ts --limit 50
# Imported problems now live in benchmarks/exercises-aider/ and run with every benchmark invocation.
```

### Source B — Session-replay corpus (P2)

Real user sessions from `~/.veepee-code/sessions/`, judged by a strong local model on a 4-item binary rubric. Only reliable predictor of conversational quality regressions.

```sh
# Extract corpus from sessions
npx tsx scripts/extract-corpus.ts --limit 50

# Replay against a candidate
npx tsx scripts/replay-corpus.ts \
  --candidate qwen3-coder:30b \
  --judge gpt-oss:120b \
  --proxy http://10.0.153.99:11434
```

Rubric items (all binary pass/fail): usable output / real_tools / addressed_intent / no_fabrication. Exits non-zero if pass rate < 80%.

### Source C — Git-history replay (repo-specific ground truth)

Every accepted commit is ground truth. The commit message is the user intent that was in someone's head; the diff is what actually shipped. A model that can reproduce that transformation on your specific codebase is adapted to your style and conventions — not just generic benchmark problems.

```sh
# Extract commit corpus (filters to source-code commits of ≤4 files, not merges)
npx tsx scripts/extract-git-history.ts --limit 40

# Replay against candidate — worktree checkout + typecheck verdict per commit
npx tsx scripts/replay-git-history.ts \
  --candidate qwen3-coder:30b \
  --proxy http://10.0.153.99:11434
```

Verdict per commit: `PASS` (typechecks after candidate edits) / `COMPILE` (edits don't typecheck) / `NOOP` (candidate didn't edit anything) / `ERROR` (timeout or crash). Exits non-zero if pass rate < 50%.

### Running all gates in one shot

```sh
npx tsx scripts/run-all-gates.ts --candidate qwen3-coder:30b
```

Chains: main benchmark → Source B replay → Source C replay. Any gate failure kills the chain (unless `--continue-on-fail`). Combined verdict JSON lands in `benchmarks/gates/<model>-<date>.json`. Exit code is 0 only if every run gate passes. This is the single command to run before proposing any model switch.

## Predictions (P5)

Pre-register your expected ranking **before** running the benchmark to fight confirmation bias:

```sh
npx tsx scripts/new-prediction.ts
# Fill in benchmarks/predictions/<today>.md, then run the benchmark and compare.
```

If your miss rate is > 30%, either the benchmark or your predictions are uncalibrated — both are useful information.

## Model roster

After a run, the best model for each role is saved to `~/.veepee-code/benchmarks/roster.json`. Role floors (P6):

| Role | Min tok/s | Weighted by |
|---|---|---|
| `act` | 10 | overall score |
| `plan` | 2 | reasoning |
| `chat` | 15 | instruction following + 5× speed |
| `code` | 10 | 0.6 × codeGen + 0.4 × codeEdit |
| `search` | 15 | toolCalling + 8× speed |

If no model clears the floor, the slot is left `null` and the UI surfaces this in red rather than silently falling back to a slow model.

## Promotion checklist

Do NOT promote a model based on aggregate benchmark score alone. Required gates:

1. Clears all per-role speed floors for the intended role
2. No hallucinated-tool calls in the benchmark
3. Passes ≥ 80% of the session-replay corpus (Source B)
4. Passes ≥ 50% of git-history replay (Source C)
5. Passes all seeded regressions (P4)
6. Predictions-vs-actual miss rate ≤ 30%
7. Does NOT tie at 100/100 with another candidate — if it does, add a harder test (P7) and re-run

The single command that checks most of these: `npx tsx scripts/run-all-gates.ts --candidate <model>`.

## Success criteria for the whole benchmark

After all P0–P7 improvements are in place the following should be true:

1. A deliberately broken model (e.g. `llama3.2:1b`) ranks last by ≥ 30 points
2. No two models tie at 100/100 overall
3. Every promotion yields a binary recommendation backed by concrete pass/fail evidence, not a scalar score
4. The benchmark catches at least one production failure mode before it hits production

## Storage

```
~/.veepee-code/benchmarks/
├── roster.json                          # Model roster (best per role)
├── latest.json                          # Always points to the most recent run
└── benchmark-2026-04-14T....json        # Timestamped history
```

Each results file contains an array of `BenchmarkResult` objects with full scores, performance metrics, context probing data, errors, and timestamps.
