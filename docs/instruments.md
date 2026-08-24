# What each instrument can and cannot say

Written 2026-08-23, **before** the first blind real-repo numbers came back. The
timing is deliberate: an instrument's fitness has to be settled on grounds that
exist independently of the result, or the result picks the epistemics.

## `benchmarks/harness/` — 15 synthetic tasks

**Retired as a confidence input. Kept as a regression canary.**

It is disqualified from speaking to the goal on grounds that were true before any
score existed:

- single-repo, sub-10-file, purpose-built problems;
- the grader is written by the same person who writes the tasks (and one of those
  graders was wrong tonight — `remove-dead-code` scored 0/5 on work the model had
  done perfectly);
- it measures a population that barely overlaps the real one. Measured: **38 of
  50 recent veetv commits have no tests at all**, and the suite's task shape
  covers roughly a quarter of what actually gets committed to these repos.

None of that is a criticism of what it does well. It found real harness bugs
today — silent exit codes, an inverted nudge, a stalled loop — and it runs in six
minutes. That is a pre-merge gate, and it keeps that job.

What it can never do is answer "does vcode edit real repos as well as Claude
Code". Two different jobs; one number must not serve both.

## `--repo-eval` — commit replay against real repositories

The instrument that speaks to the goal, with stated limits:

- **Blind by default.** The agent gets the commit message and never sees the
  tests it is judged by, so the task is not spec-complete and cannot be passed by
  editing the oracle.
- **Validated.** Every task is confirmed to start red, with the oracle brought in
  and hidden again.
- **Population is stated, not laundered.** It measures test-shaped commits.
  That is the well-scoped quarter of real work. Every result says so.

### Failure classes, and why the split matters

A pass rate is not the output. Four counts are:

| class | meaning | whose problem |
|---|---|---|
| `model` | the model produced wrong or incomplete content while the harness did its job | out of scope — model size |
| `harness` | vcode lost, truncated, mis-parsed, mis-routed or dropped something | **mine, and the entire remaining job** |
| `budget` | stopped by a limit we imposed — turn cap, deadline, stuck-loop guard | mine; a limit is not an inability |
| `alternative-impl` | repo's pre-existing suite passes; only this commit's tests fail | grader artifact, needs a human |
| `unclassified` | anything else | counts as **harness** until proven otherwise |

`budget` exists because a harness-imposed stop looks exactly like a model
failure, which is tonight's whole theme with the sign inverted: an unknown
reported as a fact, versus a limit reported as an inability.

The claim "the residual gap is model size" is only supportable when
`harness + budget + unclassified` is zero. Until then that residue *is* the
distance from the goal, and its size is the honest progress metric.
