# What each instrument can and cannot say

Written 2026-08-23, **before** the first blind real-repo numbers came back. The
timing is deliberate: an instrument's fitness has to be settled on grounds that
exist independently of the result, or the result picks the epistemics.

## Void: every score measured before 2026-08-23 23:0x

`write_file` had **never** been able to create a file in a directory that did not
already exist. Not a regression — it had never worked. Every number produced
before that fix was measured on a harness that could not do a basic thing, so:

- the 15-task suite's **91% is void**, not caveated;
- the earlier 88% on the previous artifact is void;
- any rubric dimension scored off those runs is void.

They are not carried forward with an asterisk. A number measured on a harness
that could not create a file is not a smaller version of the truth; it is a
measurement of something else.

The reason it survived a full day of synthetic evals is structural: those
workspaces are flat, so "add a new module in a new directory" — an ordinary act
on a real repository — never came up.

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

## The guard rule

Three guards I added in one night each killed a working run. The shallow reading
is "machinery added faster than it was measured". The useful one is that all
three had the **same shape**:

> a guard inferred a state from an ambiguous surface signal, then took a
> **terminal** action on that inference.

Three identical failing commands *look* like a loop and *are* a debugging cycle.
Missing detail *looks* incomplete and *is* concision. Each guard resolved the
ambiguity by assuming the bad case, and then killed something.

That is the exact twin of the absence family: **absence reported as fine;
ambiguity resolved as failure.** Both are the harness deciding something it does
not know and acting as though it does.

### The rule

**A guard may not take a terminal action on an inferred state.**

- **Proven** states — an exit code, a byte count, a wall clock, a token count —
  may terminate.
- **Inferred** states get the reversible rung: tell the model, let it override,
  log it.
- The ladder is observe → warn → terminate, and only the bottom rung may be
  reached from evidence rather than inference.

Applied: the repeated-failure detector now warns and clears its window, and only
stops the run if the pattern survives the warning. The wall-clock deadline is a
proven state so it may terminate — but it warns five minutes out first, because a
task killed mid-edit had work it could have landed.

New machinery ships **default-off** as well. A disabled wrong guard is still a
latent wrong guard, so default-off is not a substitute for the rule — it is what
lets an A/B decide the default instead of an argument.
