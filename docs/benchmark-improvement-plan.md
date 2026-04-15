# VEEPEE Code Benchmark — Improvement Plan

**Authored:** 2026-04-14, after the 48-hour Llama Rider benchmark rebuild cycle.
**Purpose:** Give a future Claude Code session everything it needs to upgrade the vcode benchmark without re-discovering the lessons learned on the sibling project.

---

## Context — why this plan exists

This plan was written immediately after rebuilding the benchmark for Llama Rider (a sibling agent project at `~/llama_rider` on `vp@10.0.153.99`). Over 48 hours, three model switches were made based on benchmark scores — all three failed in real production use. The post-mortem revealed a set of benchmark-design gaps that, once addressed, produced a much more trustworthy evaluation system.

The vcode benchmark has the same architectural shape as the pre-rebuild Llama Rider benchmark. Applying those lessons here, in priority order, will save the same cycle of failed promotions.

### Core lesson (applies to both projects)

> Aggregate benchmark scores do NOT reliably predict agent production performance. The industry (Anthropic, Sierra, Cognition, Cursor, Aider, Ramp) has converged on this. Use benchmarks as a FILTER for obviously-broken models, not as a RANKER to pick winners. Real traffic replay + execution-based ground truth + failure-mode regression tests are what actually work.

### Where vcode has a killer advantage over Llama Rider

**Coding has deterministic ground truth.** A generated function either compiles or it doesn't. A test suite either passes or it fails. A multi-file edit either produces a correct diff or it doesn't. Llama Rider is stuck with LLM-as-judge for conversational quality; vcode can run real compilers and real tests.

**Exploit this.** Execution-based evaluation beats every other signal.

---

## Current state of the vcode benchmark (as of 2026-04-14)

### Files

- `src/benchmark.ts` (~1250 lines) — main engine, inline TEST_SUITE, tok/s measurement, roster selection
- `scripts/benchmark.ts` (~120 lines) — CLI runner
- `docs/benchmark.md` (~253 lines) — methodology doc
- `test/benchmark-roster.test.ts` (~89 lines) — tests for the benchmark itself
- `benchmarks/results.json` — prior results (44+ model variants tested)

### Categories and weighting

- Tools 30%, CodeGen 25%, Edit 15%, Follow 15%, Reason 15%
- 11 test cases total, all single-turn
- 0-100 scalar scores per test, weighted averaging into categories

### What the benchmark does well

1. **Real OpenAI-compatible tool schemas** (not simplified stubs)
2. **Streaming endurance test** — explicitly catches timeout-on-long-output silent-truncation failures
3. **Role-based roster selection** — distinct picks for `act`/`plan`/`chat`/`search`/`code` with per-role speed floors
4. **Steady-state tok/s correctly measured** — first-token latency excluded from generation speed calculation
5. **Multi-server fleet benchmarking** — can hit the proxy or direct nodes

### What it's missing (based on Llama Rider lessons)

1. **All tests are single-turn.** Coding is inherently multi-turn ("also add X", "wait, break that into functions"). Biggest gap.
2. **Synthetic context padding** doesn't replicate real multi-file / multi-error state
3. **No replay from real traffic.** Can't capture "this specific user session failed" and make it a permanent regression
4. **No failure-mode regression infrastructure.** When a real task breaks, no workflow to add it as a test
5. **No tool-name validity gate as hard fail.** Wrong tool name is a soft penalty (10-20/100), not an instant 0
6. **No negative control model.** If all candidates score 90+, no way to detect benchmark saturation vs actual capability
7. **No pre-registered predictions.** Confirmation-bias risk is high
8. **Keyword-based validators for code gen.** A response containing `interface` passes; whether the TypeScript actually compiles is not checked
9. **Speed floor too low.** `chat ≥3 tok/s` is below human speech pace; real interactive coding needs 15+ tok/s

### Prior results reveal calibration problem

Top of current leaderboard (from `benchmarks/results.json`):
- qwen3-coder-next (79.7B): **100/100**, 29 tok/s
- gpt-oss:120b: **100/100**, 21 tok/s
- mistral-small3.2:24b: **100/100**, 8 tok/s
- lfm2:latest (23.8B): **99/100**, 29 tok/s

Four models tied at or near 100. This is **benchmark saturation** — the exact "3-point spread is noise" problem that bit Llama Rider. When the benchmark can't discriminate among top candidates, aggregate score is useless as a promotion signal.

---

## Implementation plan — priority order

Effort estimates assume a focused Claude Code session. Each phase is independently valuable; do not block on later phases.

### P0 — Execution-based code-gen tests (~8 hours)

**The single biggest signal improvement possible for vcode.**

Replace keyword matching for CodeGen category with actual code execution. Concretely:

1. Create `benchmarks/exercises/` with 15-25 small, self-contained coding problems. Each is a directory:
   ```
   benchmarks/exercises/
     is-prime/
       problem.md          # User prompt to send to model
       starter.ts          # Optional seed file
       expected.test.ts    # Test suite model must pass
       metadata.json       # { timeout_ms, language, allowed_imports, ... }
   ```
2. Source material:
   - Small, solved Exercism problems (https://exercism.org/tracks/typescript, public domain)
   - Aider's polyglot-benchmark data (Apache 2, see https://github.com/Aider-AI/polyglot-benchmark) — this is exactly the right source and is battle-tested
   - A handful of vcode-specific tasks: "fix this off-by-one", "add a Zod schema for this type"
3. Runner (`src/benchmark.ts` new code path):
   - For each exercise: send `problem.md` as user prompt + `starter.ts` + available tools (real `write_file`, `edit_file`, `read_file`, `shell`)
   - Model writes to a temp dir (scoped, not `/tmp` — use `benchmarks/scratch/<uuid>`)
   - Runner executes `expected.test.ts` via `vitest run` or `tsc --noEmit` + `node`
   - Binary: **tests passed** / **tests failed** / **timeout** / **compile error**
4. Scoring: replace keyword-based CodeGen validators. Pass = 100, fail = 0. No partial credit. Pass rate per model becomes the CodeGen category score.
5. Isolation: each exercise runs in a subdirectory wiped between runs. No network access during test execution (pass `--no-network` if using a sandbox; otherwise document assumption).

**Acceptance criteria:**
- Existing `llama3.2:3b` benchmark run scores < 40/100 on CodeGen (real weak models fail real tests — current keyword version rates it higher)
- qwen3-coder-next scores between 60-90 (not 100 — the ceiling effect disappears)
- Benchmark run time increases by ~5-10 min per model (acceptable)
- Clear delta between top candidates that were previously tied at 100

**Why this matters most:** This changes the benchmark from measuring "does the response contain plausible-looking code" to "does the code actually work." It's the truth signal Llama Rider can never have.

---

### P1 — Multi-turn edit tests (~6 hours)

Coding is multi-turn. A model that generates a correct function in one shot but breaks it in turn 2 is useless. The current benchmark misses this entirely.

1. Add a new test type `multiturn_edit` to `src/benchmark.ts`
2. Each test is a sequence:
   ```typescript
   {
     name: "calculator: add → multiply → null-safe",
     category: "edit",
     turns: [
       { user: "create a Calculator class with add(a,b) and subtract(a,b)" },
       { user: "now add multiply(a,b)" },
       { user: "make add(a,b) handle null inputs by treating them as 0" },
     ],
     validate: { /* final state must have all 3 methods, null-safe add */ }
   }
   ```
3. Validation: after the final turn, the resulting file is compiled and a generated test suite runs. Turn-by-turn validators can also check intermediate diffs (did turn 2 break what turn 1 did?).
4. At least 5 multi-turn tests covering:
   - Incremental feature addition (doesn't break prior features)
   - Refactor request (extract function, rename, etc.)
   - Bug-fix follow-up ("that broke X, fix it")
   - Clarification turn ("actually, make the return type `Result<T, E>`")
   - Cross-file edit ("also add a matching test in `foo.test.ts`")

**Acceptance criteria:**
- Weaker models (llama3.2:3b, qwen3:8b) show measurably lower multi-turn scores even when single-turn is comparable
- At least one model that aces single-turn demonstrably fails multi-turn consistency

---

### P2 — Real-traffic replay corpus (~6 hours)

**This is the equivalent of Llama Rider's `scripts/replay_corpus.py` — the only thing that reliably predicts production.**

vcode presumably logs sessions (verify in `src/`). If not, add structured session logging first.

1. Add `scripts/extract-corpus.ts` analogous to Llama Rider's `scripts/extract_corpus.py`:
   - Read vcode's session storage (wherever sessions live — check `src/state/` or similar)
   - Pull 30-50 real user sessions that include at least one tool call
   - Output JSONL with `{ session_id, prior_messages, target_user_msg, production_response, production_tool_calls }`
   - Save to `benchmarks/corpus/latest.jsonl`
2. Add `scripts/replay-corpus.ts`:
   - For each sample, replay prior messages + target user message against a candidate model
   - Score via deterministic validators where possible (did the model call the same tool the human accepted?) + LLM judge for subjective quality
   - Judge model: a strong local model that's not the candidate (e.g., gpt-oss:120b if local, or qwen3.5:122b — same pattern Llama Rider uses)
3. Rubric for the judge (4 binary items, not 0-100):
   - Did it produce usable code? (pass/fail)
   - Did it call real tools (no hallucinated names)? (pass/fail)
   - Did it address the user's intent? (pass/fail)
   - Did it avoid fabrication (inventing APIs, file paths that don't exist)? (pass/fail)
4. Output JSON report: per-sample verdict, aggregate pass rate, hallucination count

**Acceptance criteria:**
- Replay works end-to-end against current preferred model without errors
- Corpus contains at least 30 real sessions with tool calls
- Judge output parses reliably as JSON

**Cross-reference:** See Llama Rider's `scripts/replay_corpus.py` at `vp@10.0.153.99:/home/vp/llama_rider/scripts/replay_corpus.py` for the pattern.

---

### P3 — Tool-name validity gate (~1 hour)

Minimal change, huge safety value. Directly ported from Llama Rider.

1. Add `benchmarks/tool-registry.json`:
   ```json
   { "tools": ["read_file", "write_file", "edit_file", "shell", "grep", "glob", /* ... */] }
   ```
   Generate by scraping actual tool definitions in `src/` — not hand-typed.
2. Load at benchmark startup
3. In the main test loop, after the model emits tool calls, check every call name against the registry. Any name not in the set → hard fail that test (score = 0, reason = "HALLUCINATED_TOOL: <name>")
4. Test-local tools (synthetic schemas used only in a specific test) get an allowlist via each test's own tool definitions — a call is valid if it's in `registry ∪ test.tools`

**Acceptance criteria:**
- Any model that hallucinates `python_interpreter:execute` or `google:search` or similar vendor-style names fails immediately
- Existing passing tests still pass (no false positives on synthetic test-only tools)

**Cross-reference:** See Llama Rider `scripts/benchmark.py` `hallucinated_tool_names()` function and `benchmarks/tool_registry.json`.

---

### P4 — Failure-mode regression tests (~2 hours initial, ongoing maintenance)

Every production failure becomes a permanent regression test with the exact triggering input.

1. Create `benchmarks/regressions/` as a directory of JSONL files, one per failure
2. Each regression file:
   ```jsonl
   {
     "id": "REG-001",
     "date": "2026-04-14",
     "description": "Model X hallucinated python_interpreter:execute when asked for IP",
     "session_context": [/* prior messages */],
     "user_message": "what is my IP",
     "failure_criterion": { "type": "no_hallucinated_tool" },
     "minimum_passing_score": 100
   }
   ```
3. Runner loads regressions into benchmark suite automatically. They're part of every run, high weight.
4. When a new production failure happens: document it, distill into a regression test, add to `benchmarks/regressions/`.

**Acceptance criteria:**
- At least 3 seeded regression tests (port the concept from Llama Rider's REG-001/002/003)
- Runner treats them with triple weight so they can't be drowned by other tests
- Documentation block in `docs/benchmark.md` explaining "when a production failure happens, this is how you add it"

---

### P5 — Negative control and pre-registered predictions (~2 hours)

1. **Negative control model** — reserve one slot in every benchmark run for a deliberately bad model (e.g., `llama3.2:1b` or similar). If it ranks in the top 3, the benchmark isn't discriminating and should be investigated.
2. **Pre-registered predictions** — before every benchmark run, author writes `benchmarks/predictions/<date>.md` with expected rankings and any specific pass/fail predictions (e.g., "qwen3-coder-next will rank top-3; gpt-oss:20b will rank middle; lfm2:latest will pass multi-turn tests"). Compare predictions to outcomes in a summary section after the run. Miss rate > 30% means the benchmark, the predictions, or both are off.

**Acceptance criteria:**
- Runner prints "NEGATIVE CONTROL RANKING: #N" at end of each run with a warning if N ≤ 3
- `predictions/<date>.md` template auto-generated when running benchmark (for authorship)

---

### P6 — Raise speed floors to match interactive UX (~30 min)

Current floors: `act ≥2`, `plan ≥1`, `chat ≥3`, `search ≥3` tok/s. These are well below human speech pace (~3.3 tok/s text equivalent).

For interactive coding agent use:
- `chat` floor → 15 tok/s (below this, users wait longer than the bot speaks)
- `act` floor → 10 tok/s (tool-calling is cheaper tokens, more tolerance)
- `code` role → 10 tok/s (code generation is a chunk of tokens; 10 is tolerable)
- `search` → 15 tok/s
- `plan` can stay low (planning is occasional, not interactive)

**Acceptance criteria:**
- Any model below 15 tok/s explicitly disqualified for `chat`/`search` roles
- Role-selection output makes it clear when a model is chat-unfit but still act-fit

---

### P7 — Eliminate ceiling effect on high-performing tests (~2 hours)

The Tools and CodeGen categories produce 100/100 for multiple top candidates. Add harder tests until the ceiling cracks:

- Tools: add a test with 12+ tools of similar signature (current max is 3). Forces real discrimination.
- CodeGen: add tests requiring external library usage, multi-file edits with cross-file constraints, bug-fix tests with subtle logic errors (not obvious syntactic ones)
- Reasoning: add at least 3 tests with counter-factual reasoning, multi-hop planning, constraint satisfaction

**Acceptance criteria:**
- No more than 1 model scores 100/100 overall after re-run with expanded suite
- Category scores show meaningful differentiation (≥15 point spread among top 5)

---

## Cross-project references — what to look at in Llama Rider

When implementing any phase above, these are the reference implementations on the sibling project:

| Phase | Reference file on `vp@10.0.153.99:/home/vp/llama_rider/` |
|---|---|
| P0 (execution tests) | No direct analog; vcode has to invent this — Aider's polyglot-benchmark repo is the best external reference |
| P1 (multi-turn) | `scripts/benchmark.py` — see `PROD: IP question with user pushback` and similar for the multi-turn test pattern |
| P2 (replay corpus) | `scripts/extract_corpus.py`, `scripts/replay_corpus.py` — direct port |
| P3 (validity gate) | `benchmarks/tool_registry.json`, `scripts/benchmark.py` `hallucinated_tool_names()` |
| P4 (regressions) | `scripts/benchmark.py` — search for `REG-001`, `REG-002`, `REG-003` |
| P5 (predictions) | `benchmarks/predictions.md` |
| P6 (speed floors) | `scripts/benchmark.py` — look for `--min-tps` default of 15 and rationale in commit `def0048` |
| P7 (ceiling) | Llama Rider hit this too — see `scripts/benchmark.py` regression tests + production trajectory tests |

Also read:
- `/home/vp/llama_rider/README.md` "Choosing an Ollama Model" section + "Lessons Learned" section (commit `a0290c0`)
- `/home/vp/llama_rider/docs/` if present

---

## Suggested order of execution

If starting fresh, the right order is:

1. **P3** (tool-name validity gate, 1h) — fastest high-value improvement
2. **P0** (execution-based code tests, 8h) — biggest truth-signal upgrade
3. **P4** (regression test structure, 2h) — before the first new failure lands
4. **P1** (multi-turn, 6h)
5. **P2** (replay corpus, 6h)
6. **P6** (speed floors, 30m)
7. **P5** (negative control + predictions, 2h)
8. **P7** (ceiling-cracking harder tests, 2h)

Total effort: ~27 hours across one or two focused sessions.

---

## What NOT to do

Based on Llama Rider mistakes — don't:

- **Don't use simplified tool schemas in tests.** Match the real production registry exactly.
- **Don't use short system prompts in tests if production uses long ones.** Context dilution is real and silent.
- **Don't measure tok/s including cold load time.** Current vcode does this right; don't regress.
- **Don't pass@k at fixed temperature.** Paraphrase-perturbation is the better reliability test (we learned this the hard way).
- **Don't trust aggregate scores in the top band.** Top-3 cluster at 100/100 in vcode's current data — that's noise, not signal. Need harder tests or execution-based truth.
- **Don't recommend a model switch based on benchmark alone.** Replay corpus + real production trial are required gates.

---

## Out of scope for this plan

- Shadow-mode testing. Llama Rider ruled this out because it requires dedicated GPU capacity to run candidate alongside production. vcode has the same constraint.
- Continuous evaluation on external benchmarks (HumanEval, SWE-bench). Consider adding as informational signals only — not as promotion gates.
- Rewriting the benchmark in a different language. TypeScript is fine.

---

## Success metric for this entire plan

After all phases complete, the following should be true:

1. A deliberately broken model (e.g., llama3.2:1b) ranks last by ≥30 points. The benchmark discriminates.
2. No two models tie at 100/100. Ceiling effect gone.
3. When a new model is proposed for production promotion, running the benchmark + replay corpus produces a binary recommendation backed by concrete pass/fail evidence — not a scalar score.
4. The benchmark catches at least one production failure mode before it hits production, without human inspection.

If all four are true, the benchmark predicts production well enough to trust for promotion decisions.

---

## Author notes

Written while Llama Rider's `replay_corpus.py` was running in the background against 4 candidate models. Context is fresh. The lessons here are hard-earned, not theoretical.

Cross-session continuity note: a future Claude Code session reading this plan can rely on its own memory file at `/home/vp/.claude/projects/-home-vp-Dev/memory/llama-rider-benchmark.md` for more details on any specific point.
