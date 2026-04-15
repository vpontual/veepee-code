# Benchmark Follow-Ups

Tracking issues discovered while running the benchmark that we deliberately deferred — short-circuit the urge to fix them mid-run, capture here, address after.

## Open

(none)

## Resolved

### ✅ vcode's tool-support detector rejects models Llama Rider confirmed as tool-capable

**First observed:** 2026-04-15, during the first full DGX Spark benchmark run.

**What happened:** `scripts/benchmark.ts --server dgx-spark --force` rejected 12 of 26 DGX models at the tool-support phase with `no tool support — skipping`. Scope of the false-negative set:

Rejected (tool-capable per Llama Rider's same-proxy check): `glm-4.7-flash`, `gemma4:26b`, `gemma4:31b`, `qwen3.5:122b`, **`qwen3.5:35b`** (Llama Rider's current production model), `qwen3.5:9b`, `qwen3-next:80b`, `qwen3:8b`, `nemotron-3-super:120b`.

Rejected (genuinely no tool support or non-chat models): `deepseek-r1:32b`, `gemma3:4b`, `qwen2.5-coder:7b-instruct`.

Passed: `command-r:35b`, `mistral-small3.2:24b`, `qwen2.5:32b`, `qwen2.5:14b`, `gpt-oss:20b`, `gpt-oss:120b`, `qwen3-coder-next:tools`, `qwen3-coder-next:latest`, `llama3.2:3b`, `llama4:latest`.

The pattern: thinking-family models (`qwen3.5:*`, `qwen3:*`, `qwen3-next`, `gemma4:*`) are the systematic false-negatives. Their probe responses need more tokens before the tool call emerges, or the detector isn't tolerating the `<think>...</think>` scaffolding that precedes their tool output.

**Why it matters:** These are two of the strongest candidates for the `code` / `act` roles on the DGX. Filtering them out before scoring means the benchmark silently excludes models that might rank at or near the top. Current vcode roster selection is biased toward whatever subset of the fleet passes this one check.

**Where to look:**
- `src/benchmark.ts` — `checkToolSupport()` (the function that issues the probe request)
- Compare to `scripts/benchmark.py` on Caya (`vp@10.0.153.99:/home/vp/llama_rider/scripts/benchmark.py`) — its `check_tool_support()` uses a single `get_weather` probe with a 128-token budget and succeeds on both models. Diff the probe prompt, token budget, and tool schema shape.

**Likely causes (in priority order):**
1. Token budget too small — thinking-family models (qwen3.5) may need 300+ tokens before emitting a tool call and get cut off
2. Tool schema shape differs from what Llama Rider uses — maybe these models are picky about JSON-schema vs OpenAI-style `function` wrappers
3. Probe prompt wording trips these specific models ("Reply using a tool" vs something else)
4. Timeout too short — gemma4:26b is ~22 tok/s so a 10s timeout could kill it mid-generation

**Suggested fix:** borrow Llama Rider's detector shape — 512-token budget, `think: false`, OpenAI tool-call format, 180s timeout (see `check_tool_support` at /home/vp/llama_rider/scripts/benchmark.py lines ~1560-1585 in commit `6213ace+`).

**Do not fix while a benchmark is running** — changing the detector invalidates any in-progress results and we'd have to rerun everything.

**Fix shipped:** commit `5961fdb` (2026-04-15) — ported the Llama Rider detector shape directly. Verified on DGX against all three of qwen3.5:35b, gemma4:26b, qwen3-coder-next — all now return `tool_calls` on first try. A scratch probe script at `scripts/probe-tool-support.ts` (not committed) was used to verify before running the full benchmark.
