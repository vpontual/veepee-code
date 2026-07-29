---
title: "Goal Mode"
description: "Work autonomously until a real command passes — budgets, stall detection, pause and resume."
weight: 16
---

# Goal Mode

`/goal` works unattended toward a goal until **a real command exits 0**.

```bash
vcode --goal "fix the failing auth tests"
vcode --goal --verify "npm test" "make the retry logic handle 429s"
vcode --goal --max-attempts 20 --budget-minutes 90 "port the CLI to the new config loader"
vcode --goal --resume ab12cd
vcode --goal --list
```

The same thing exists inside the TUI as `/goal <task>`.

## The one rule that matters

Success is the exit code of the verify command. The model never gets a vote.

That is the whole difference from `/ralph`, which is a text loop where a reviewer model decides when the work is good — the judgement local models are worst at. Here the loop is graded by the project's own test suite, build, or linter.

For the same reason, **the verify command is never written or modified by the model**. It comes from `--verify`, or from the project's own manifest (`scripts.test`, then `scripts.build`, then `pytest`/`cargo test`/`go test`/`make test`). The prompt tells the agent explicitly not to edit the command, the scripts it runs, or the tests it runs — because if it could, the loop's only real stopping condition would be forgeable.

## Why this fits this fleet

On a metered API, "keep trying until the tests pass" is a way to spend money quickly, which is why hosted agents are tuned to stop early and ask. Here the GPUs cost the same whether they sit idle or grind for an hour. Unattended wall-clock is the resource this setup has, and goal mode is what spends it.

That advantage evaporates the moment the loop spins without progress, so most of the machinery is about noticing that quickly.

## Knowing when to stop

| Outcome | What happened |
|---|---|
| `succeeded` | The verify command exited 0. |
| `stalled` | The same failure three times running. |
| `failed` | The agent itself could not run twice in a row — backend down, context rejected. |
| `exhausted` | Out of attempts, wall clock, or tokens. |
| `paused` | You stopped it. Resumable. |

**Stall detection** fingerprints the verify output each attempt, normalising away timings, temp paths and pids so that two identical failures are recognised as identical. Three in a row ends the run rather than spending the rest of the budget re-making the same edit. Before that point the model is told its last attempts produced the same failure and to look somewhere it has not looked.

**Backend failures exit fast.** Two consecutive agent-level errors stop the run in seconds:

```
== attempt 1/20
  AGENT ERROR fetch failed ECONNREFUSED 10.0.154.246:8000
== attempt 2/20
  AGENT ERROR fetch failed ECONNREFUSED 10.0.154.246:8000

STATUS failed: The agent could not run 2 times in a row: fetch failed …
attempts=2 tokens=0 wall=7s
```

"The DGX is down" and "the model wrote the wrong code" both end with a non-zero verify exit. Reporting them the same way would mean discovering an outage twenty attempts and an hour later.

## Budgets

| Flag | Default |
|---|---|
| `--max-attempts` | 10 |
| `--budget-minutes` | 60 |
| `--max-tokens` | unlimited |

Checked before committing to another attempt, and enforced mid-attempt by a deadline that aborts the agent — so one wandering attempt cannot outlive the whole run's allowance. The deadline is measured against cumulative spend, so a resumed run inherits what its earlier attempts already used.

## Checkpoints

Every attempt snapshots the working tree first, so a run that made things worse is one `/rewind` away from undone. Checkpointing failures never fail a run — losing a snapshot is an inconvenience, losing an hour of work over one is not.

## Pause and resume

Ctrl+C pauses: it finishes settling the current attempt, writes state, and exits. A run may represent an hour of unattended work, so throwing it away because someone wanted to stop watching would be the wrong default. Press it twice to quit outright.

State lives in `.veepee/goals/<id>.json`, written atomically each attempt.

Resume **re-runs verify before spending a single model call** — the world may have moved on, and you may have fixed it by hand:

```
$ vcode --goal --resume ab12cd
SUCCEEDED — Verify already passes — nothing to do.
```

A run can only be resumed from the directory it belongs to; resuming elsewhere is refused rather than quietly working on the wrong tree.

## What each attempt records

`toolCalls`, `toolErrors`, `tokens`, `wallMs`, the verify exit code, the failure tail, and the checkpoint id — so a long unattended run is reviewable afterwards instead of being a wall of scrollback.
