# Absence sites

Every point in vcode where a value can be **missing** and something must still be
handed to the model.

This is not a general bug list. It is one specific failure class, and it is the
only class a pass rate can never surface — because it makes the agent **more
likely to pass while being wrong**. A timeout reported as clean, a failing
command reported as successful, a truncated tool call executed with defaults:
each of those removes an obstacle the agent should have hit. A rising score is a
symptom of this bug, not a refutation of it.

Five instances were found and fixed on 2026-08-23. Five is a discovery rate, not
a total. The point of this document is the **denominator**: the enumeration is
the number, and a site that is missing from the list is worse than one marked
unresolved.

**The invariant**: absence is a distinct value with its own rendering. Never a
falsy default, never an empty string standing in for both "nothing to report" and
"could not tell".

**The standing form is fault injection, not audit.** An audit is a claim about a
moment; regressions in this class are silent by definition, so each site should be
forced to fail and asserted to produce an explicit unavailability marker. Those
live in `test/absence-sites.test.ts`.

| # | Site | Absence looks like | Status |
|---|---|---|---|
| 1 | Streaming model response — reasoning channel | answer arrives on `reasoning`, `content` empty | **fixed** `openai-adapter.ts` → `thinking`; `9d117ed` |
| 2 | Non-streaming model response (compaction, subagents, KS, benchmark scorer) | `content: ''` with the answer on the reasoning channel | **fixed** `llm-answer.ts:nonStreamingAnswer`; `ff5ce70` |
| 3 | `bash` exit code on the grace path | non-zero exit reported as success | **fixed** `coding.ts` exit handler; `0f7ac5a` |
| 4 | `bash` killed by a signal | OOM/SIGKILL reported as success | **fixed** same commit |
| 5 | Hook exit code on the grace path | a blocking hook silently ignored | **fixed** `hooks.ts`; `0f7ac5a` |
| 6 | Sliding-window truncation | history dropped with no summary, no ledger, no notice | **fixed** `context.ts`; `35d63fa` |
| 7 | LSP diagnostics timeout | empty block read as "no problems" | **fixed** `client.ts:diagnosticsTimedOut` + explicit `<lsp_status>` |
| 8 | Tool-call arguments truncated mid-stream | parsed as `{}`; valid for any all-optional tool | **fixed** `TRUNCATED_ARGS_KEY` + registry rejection |
| 9 | Compaction summarizer returns nothing | messages dropped, "Compacted" reported, model told nothing | **fixed** explicit drop notice in `compactAsync` |
| 10 | `bash` output truncation | 512KB head kept, tail (where the error is) discarded | **fixed** `boundedStream`, middle-truncation, count stated |
| 11 | `read_file` with no limit | whole file, no ceiling, no notice | **fixed** caps + continuation offset in the output |
| 12 | Tool-output pruning | older output shortened | **proven-loud** — says what was truncated and that the tool can be re-run |
| 13 | Skills index overflow | skills silently absent from the index | **proven-loud** — remainder listed by name |
| 14 | Operator-context budget | files silently omitted | **proven-loud** — omitted files named with their paths |
| 15 | Registry tool timeout (10 min) | tool abandoned | **proven-loud** — explicit "exceeded its budget" error |
| 16 | Retry exhaustion | request gives up | **proven-loud** — error surfaces as an agent error event |
| 17 | Permission denial | tool not run | **proven-loud** — denial carries its reason to the model |
| 18 | Subagent empty final turn | `success: false, 'max turns reached'` | **proven-loud** (and #2 removed the false positives) |
| 19 | `grep` result cap | matches beyond N dropped | **proven-loud** — "(truncated at N results)" |
| 20 | LSP not configured for a file type | empty diagnostics block | **fixed** — says so once per extension per session; repeating it every edit would train the model to skip the block |
| 21 | `web_fetch` empty response body | `''` | **fixed** — reports status, content-type, and that a JS-rendered page looks identical |
| 22 | `deep-research` internal failures | `catch { return [] }` × 5 | **unresolved** — feature path, absent sources look like no sources |
| 23 | Knowledge-state save failure | `.catch(() => {})` | **unresolved** — not model-visible, but state loss is silent |
| 24 | MCP tool result empty | passthrough | **unresolved** — not audited |
| 25 | `system_info` sub-command failures | partial output | **unresolved** — a missing section reads as a system with no such data |

**Score: 21 fixed or proven-loud, 4 unresolved, 25 enumerated.**

Unresolved sites are allowed. Hidden ones are not — the gate for any confidence
claim above 90 is that every site here is either fault-injection tested to fail
loud, or listed as unresolved. A count of what was found is not a gate; it is
satisfied by not looking.

## How to find more

Greppable shapes, each of which has produced a real instance:

- `catch { return '' | [] | null | false | 0 }` — an error becoming an empty result
- a `setTimeout` path that resolves with a default instead of recording that it fired
- an empty array or string meaning both "clean" and "did not ask"
- `?? ''` / `|| ''` on anything that reaches the model
- a boolean success flag computed from a request rather than from an outcome
