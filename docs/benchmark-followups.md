# Benchmark Follow-Ups

Tracking issues discovered while running the benchmark that we deliberately deferred — short-circuit the urge to fix them mid-run, capture here, address after.

## Open

### vcode's tool-support detector rejects models Llama Rider confirmed as tool-capable

**First observed:** 2026-04-15, during the first full DGX Spark benchmark run.

**What happened:** `scripts/benchmark.ts --server dgx-spark --force` rejected `gemma4:26b` and `qwen3.5:122b` at the tool-support phase with `no tool support — skipping`. Both models score highly on tool calling in the sibling Llama Rider benchmark (gemma4:26b = 100/100 on tool calling there) hitting the same Ollama proxy, so this is a false negative specific to vcode's detector — not an actual model limitation.

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

---

## Resolved

(nothing yet)
