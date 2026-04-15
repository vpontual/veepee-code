# Benchmark Results — 2026-04-15

First end-to-end comparison with all filter-phase and replay-script fixes in place. Three candidates evaluated head-to-head with both synthetic benchmark and real git-history replay.

## Candidates

All three cleared the `code` role floors (tool-capable, ≥10 tok/s, can emit well-formed `edit_file` / `write_file` calls).

| Model | Synth | Tools | CodeGen | Edit | Follow | Reason | tok/s | Git replay PASS | COMPILE | NOOP | ERROR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **qwen3-coder-next:latest** | 99 | 100 | 100 | 100 | 100 | 91 | 28 | **12/20 (60%)** | 5 | 0 | 3 |
| **qwen3.5:35b** | 90 | 74 | 100 | 100 | 100 | 86 | 34 | **12/20 (60%)** | 7 | 0 | 1 |
| **gemma4:26b** | 89 | 69 | 100 | 100 | 100 | 91 | 12 | **10/20 (50%)** | 3 | 5 | 2 |

## Key finding

**The 9-point synthetic benchmark gap between qwen3-coder-next (99) and qwen3.5:35b (90) did not translate to real-world code replay.** Both reproduced 60% of real vcode commits into a typechecking state — identical pass rates.

This is the exact pattern the Llama Rider post-mortem predicted: aggregate synthetic scores in the top band don't discriminate candidates; only real-traffic replay does. The improved benchmark still catches weak models (gemma4 at 50% + 5 NOOPs flagged it clearly), but it couldn't rank the top two.

## Decision: qwen3-coder-next:latest for the `code` role

Chosen on three tiebreakers against qwen3.5:35b:

1. **Cleaner edits when they work** — 5 COMPILE fails vs 7 (fewer typecheck breakages to repair)
2. **Higher synthetic benchmark** — 99 vs 90 is not gospel but a consistent nonzero signal that some tasks DO differentiate
3. **Coding-specialized training** — marginal given the replay tie, but fits the role

Counterargument (which would flip the decision): **speed**. qwen3.5:35b is 20% faster (34 vs 28 tok/s) and finished more reliably (1 ERROR vs 3). For a latency-sensitive CLI, that's a real advantage. If real-world usage reveals coder-next is consistently slower-feeling, qwen3.5:35b is the rollback target.

## Rollback path

Edit `~/.veepee-code/vcode.config.json`:
```json
"model": "qwen3.5:35b"
```

Edit `~/.veepee-code/benchmarks/roster.json`:
```json
{"act":"qwen3.5:35b","plan":"qwen3.5:35b","code":"qwen3.5:35b",...}
```

## gemma4:26b rejected

- Lowest replay pass rate (50%)
- **5 NOOPs** (25% refusal rate) — reproduces the tool-use reluctance seen in Llama Rider's sibling project
- 12 tok/s steady-state — below the 15 tok/s interactive floor for chat/search
- Would be a weak choice regardless of other strengths

## Open questions (not blocking the decision)

- chat/search roles in the roster still point to `gemma3:4b` (a 4B model) — legacy from an earlier broken benchmark run. Should be updated. Low urgency since vcode's `model` field now falls back to `qwen3-coder-next:latest`, but the roster overrides for these roles need a targeted benchmark rerun.
- No session-replay corpus (Gate 2) yet — vcode doesn't persist conversation history as JSON. Separate feature work.
- SDK request timeout of ~300s kicks in on large feature-add commits — 3 of qwen3-coder-next's 20 samples hit this. Non-blocking but worth investigating if we want fully untimed replay in the future.

## Reproducibility

- Benchmark: `npx tsx scripts/benchmark.ts --server dgx-spark --models qwen3-coder-next:latest,qwen3.5:35b,gemma4:26b --force`
- Git-history corpus: `npx tsx scripts/extract-git-history.ts --limit 20`
- Replay per model: `npx tsx scripts/replay-git-history.ts --candidate <model> --proxy http://10.0.154.246:11434 --limit 20`
- Reports saved to `benchmarks/git-corpus/replay-<model>-2026-04-15.json` (gitignored; regenerable)
