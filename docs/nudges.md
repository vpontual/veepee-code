---
title: "Turn Nudges"
description: "The three self-repair prompts the agent injects before finishing a turn, and why each exists."
weight: 18
---

# Turn Nudges

In `/act` mode, when the model stops calling tools, the agent checks whether the
turn is actually finished before letting it end. Each check can inject one extra
user message and force another turn. Each fires **at most once per run**, so a
model that ignores a nudge is not trapped in a loop.

They exist because the common failure of a local model is not writing bad code —
it is stopping early with something almost done, in a way that looks like
completion.

| Nudge | Fires when | Injects |
|---|---|---|
| **force-act** | The model narrated a whole turn without calling a single tool | "act instead of narrate" |
| **force-verify** | Code changed and nothing was ever run | "verify your code change before finishing" |
| **completeness** | Files that enumerate the same set have fallen out of step | "these siblings may need the same change" |

## force-act

In act mode, a turn that analyses and never touches a tool has produced nothing.
This forces one more turn rather than "completing" with no work done.

## force-verify

A code edit followed by no `bash` call is unverified work. This is the
self-repair trigger — it is what drives generate → run → fix instead of
generate → ship. The eval's `selfVerified` metric exists to measure whether it
actually lands.

## completeness

The commonest way an otherwise-correct change is wrong: a member is added to an
enumerated set in one place and missed in the others that enumerate the same
set. A new enum case and the switch in another module. A new operation and the
validator. A new provider and the registry array. The code compiles, the
existing tests pass — nothing exercises the new member's missing half — and the
bug ships.

After a turn that wrote files, the agent scans the directories those files live
in for *enumeration sites* — a switch's case labels, an array of string
literals, a string-literal union — and compares their members across files. A
site that is a strict subset of another, sharing at least two members and
missing no more than three, is reported:

```
- src/operations.ts lists "add_column", "drop_column" but not "rename",
  which src/render.ts has.
```

Three deliberate limits:

- **It asks, it never edits.** The heuristic is good, not sound — a file may
  legitimately enumerate a subset — so the model is told to check and to say so
  if they are meant to differ.
- **It skips files the turn successfully wrote.** If the model edited a file and
  left it as it is, that was a decision. Files it *tried and failed* to edit stay
  eligible, since those are the ones most likely to have been left behind.
- **It looks only in the directories just edited**, and only at source files. A
  repo-wide scan would be slow and would surface unrelated lists; a noisy nudge
  costs a turn every time it is wrong.

### Status: unmeasured

Honest caveat. This was found by the [harness eval](harness-eval.md) catching
vcode doing exactly this — told to add a `rename` operation "following the
conventions already used", the agent added the SQL branch and the registry entry
and never touched the validator, and only the grader noticed.

But adding the nudge **did not move the score** (2/3 before and after), and
watching a real run showed why: the model was already editing the sibling file.
The binding constraint was edit application, not knowledge. The real fixes were
elsewhere — see [tools](tools.md) on whitespace handling.

It is merged because the check is sound on its own terms and carries a genuine
bug fix, not because it was shown to help. If a later eval shows it costing
turns without earning them, revert it.
