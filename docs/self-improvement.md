---
title: "Self-Improvement"
description: "Turn eval results into a reviewable branch — gated on build, tests, an untouched exam, and a better score."
weight: 17
---

# Self-Improvement

`vcode --improve` closes the loop that [harness evaluation](harness-eval.md) opened. It reads the saved eval history, works out where vcode is losing, has an agent attempt **one** fix in an isolated git worktree, and then re-measures.

```bash
vcode --improve --dry-run   # analysis only: what is going wrong, ranked
vcode --improve             # attempt the top item and gate the result
```

**It never merges, never pushes, and never deploys.** The output is a branch and a report, exactly like the nightly-engineer workflow — because the failure mode of an agent that can modify and ship its own harness is not a bug, it is an agent that has quietly stopped being reviewable.

## What it looks for

Analysis is deterministic. The point of the eval was to replace "it feels better" with a number; asking a model to interpret that number would put the guesswork straight back in.

| Kind | Trigger | Why it ranks where it does |
|---|---|---|
| `regression` | A task that passed in the previous run and fails now | Highest — the cause is bounded by two commits |
| `failing_task` | A task failing in the latest run | The direct measure |
| `tool_errors` | ≥3 failed tool calls **and** ≥25% of them | The harness fighting itself: bad descriptions or schemas |
| `no_self_verify` | Failed without ever running the tests | The force-verify nudge not landing |

```
Self-improvement — 6 eval run(s), latest 0% @ c25bf57

  1. extend-existing-pattern fails  [failing_task]
     5 tool calls, 0 errors, 36s. ❯ verify.test.ts:30 expect(() => validate({ type: 'rename', …
  2. fix-failing-test fails  [failing_task]
     10 tool calls, 1 errors, 42s. ❯ verify.test.ts:56 expect(applyDiscount(5000, pct)).toBe…
  3. extend-existing-pattern: finished without running the tests  [no_self_verify]
```

### A run that measured nothing is refused

A failure whose detail is `agent error:` means the model was never reached. That scores 0% and lists every task as failing, which looks identical to a catastrophic harness regression:

```
The latest run measured nothing: 2/2 task(s) never reached the model — model 'Qwen/…' not found on any available server
Fix the backend and re-run `vcode --eval` before improving against it.
```

Improving against that would be chasing noise.

## The gate ladder

A candidate has to clear all four, in order. It stops at the first failure.

1. **It did not touch what grades it.** Any change under `benchmarks/`, to `src/harness-eval.ts`, to `src/self-improve.ts`, or to an *existing* file in `test/`, is rejected outright — whatever it did to the score. Adding a new test is welcome; rewriting one until it agrees with the change is how a suite stops meaning anything. A candidate that changed nothing is also rejected.
2. **`npm run build` passes.**
3. **`npm test` passes.**
4. **The score actually moved.** The candidate is re-measured and must beat the baseline. Equal is a rejection: the change may well be right, but nothing proves it, and "it built and the tests passed" is not evidence that a *harness* change helped.

Checked in that order deliberately — a candidate that edited the exam does not get the dignity of a test run.

### Two details that are load-bearing

**Everything is staged before the diff is inspected.** A plain `git diff` cannot see untracked files, so a brand-new file would have been invisible to the guard — and `benchmarks/harness/trivially-easy-task/` would have sailed straight past the one check meant to stop exactly that. `node_modules` is excluded by pathspec rather than by `.gitignore`, whose `node_modules/` rule matches a directory while what gets linked in is a symlink, which git happily stages as a file.

**The re-measurement is a subprocess.** Running the eval in-process would exercise the `Agent` class *this* process loaded — the unmodified one. Both measurements shell out to the built CLI: the baseline in the repo, the candidate in the worktree after building it there. The project's `.veepee/` config layer is copied into the worktree too, since it is gitignored and the candidate would otherwise be scored on whatever the global config points at while the baseline used the project's — two scores taken on different models are not a comparison.

## The report

Written to `~/.veepee-code/improvements/<timestamp>-<verdict>.md`, with the gate table, the file list, the diff stat, and a copy-pasteable review command. The worktree is left behind either way: a rejected attempt is often the most interesting thing to look at, and deleting the evidence to keep the directory tidy is the wrong trade.

```bash
git diff main...veepee/improve-failing-task-4f13d0bd
```

## Cost

A full run is two eval runs plus an agent turn over vcode's own source. Budget tens of minutes, and expect the model to need real context headroom — a 32k-context model runs out reading the harness before it can change it, which is a limit of the model, not a defect of the run.
