---
title: "Checkpoints and /rewind"
description: "Undo file changes an agent turn made: how snapshots are taken, what they cover, and how to restore."
weight: 14
---

# Checkpoints and `/rewind`

VEEPEE Code snapshots your working tree before each turn that runs a tool, so a turn that went wrong can be undone.

This is separate from `/tree`, which rewinds the **conversation**. `/tree` moves the transcript; `/rewind` moves the **files**. They are independent on purpose — you often want one without the other.

## Usage

```
/rewind                 List recent checkpoints (newest first)
/rewind <id>            Preview exactly what restoring would change
/rewind <id> yes        Restore the working tree to that checkpoint
```

`/rewind <id>` never modifies anything. Restoring overwrites your files, so the default action is to show you the damage:

```
Restoring a3f91c2b would:

  revert   src/agent.ts
  restore  src/lsp/client.ts
  delete   src/experiment.ts

  Confirm with: /rewind a3f91c2b yes
```

Every restore takes a snapshot of the current state first, so a rewind is itself undoable — the confirmation tells you the id to get back:

```
Restored 3 file changes to checkpoint a3f91c2b.
  Undo this rewind: /rewind 91ce0044 yes
```

## What is covered

**Everything on disk**, including changes made by shell commands.

This is worth stating plainly because it is the usual limitation elsewhere. The common implementation records an undo entry as the write/edit tools run, which means it only sees edits made *through those tools* — `sed -i`, a formatter, a codegen script, `mv`, or `npm run build` are invisible to it. For an agent whose job includes running builds and scripts, that is most of the surface area.

VEEPEE Code snapshots the actual working tree instead, so it does not care what made the change.

Not covered:

- **Files your `.gitignore` excludes.** `node_modules`, build output and logs are neither snapshotted nor touched by a restore. This is what keeps snapshots cheap — a 253-file project snapshots in under 100ms, and an unchanged tree in about 7ms.
- **Anything outside the project directory.**
- **Side effects that are not files** — a database migration that ran, a container that was started, a request that was sent.

## How it works

A **shadow git repository** under `~/.veepee-code/checkpoints/<project>-<hash>/`, used with its own `GIT_DIR` and your project as the `--work-tree`.

Your real repository is never touched: not its index, HEAD, reflog, stash or branches. The snapshots are not commits on any branch and do not appear in `git log`. Running `git status` in your project shows exactly what it would have shown anyway. Projects that are not git repositories at all work the same way.

A snapshot is taken lazily, immediately before the first tool of a turn executes:

- Turns that only read cost nothing.
- A snapshot whose tree is identical to the previous one is discarded, so an unchanged repo does not fill the list.
- Snapshot failures are swallowed. Losing a checkpoint is an inconvenience; failing your turn because of one is not.

The most recent 100 checkpoints per project are kept. Git deduplicates content, so the storage cost is roughly one copy of your source tree plus the deltas.

## Restoring, precisely

A restore does three things:

1. Writes every file from the checkpoint's tree back to disk.
2. Deletes files that exist now but did not exist at the checkpoint. Without this a rewind would be half done — restoring what was there while leaving everything the agent created.
3. Leaves ignored files alone.

## When checkpointing is unavailable

If `git` is missing or the shadow repo cannot be created, `/rewind` says so and the agent runs normally without it. It is never a hard dependency.
