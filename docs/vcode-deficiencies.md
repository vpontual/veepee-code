# vcode deficiency ledger

What vcode/qwen3.6 gets wrong when it writes application code, and whether each thing is
fixable. Evidence so far comes from ONE project — veegame, a three-provider game library
and recommender, ~3,900 lines and 190 tests, built almost entirely by vcode from briefs
over 2026-08-23→25. Add evidence from later projects here rather than starting a new file:
the value is in seeing which families recur across repos and which were one project's
accident.

veegame's own product limitations are NOT here — they live in that repo's
`docs/known-issues.md`.

**The rule (VP, 2026-08-25):** any time Claude writes code instead of vcode, that is a
vcode/qwen3.6 deficiency and gets recorded here. At the end we sort them into fixable
and not.

Two categories, and the difference is the whole point of the audit:

- **FAILED** — vcode was given the work and got it wrong. The deficiency is demonstrated.
- **UNATTEMPTED** — Claude did it without ever handing it to vcode. The deficiency is
  *assumed*, not proven, and may not be real. These are the honest gaps in this ledger.

---

## A. FAILED — demonstrated, with the defect that proves it

### A1. Reads a column the query does not select (4 occurrences)
`sync.mjs` used `provider.providerId` where the interface never defined it.
`getPlayedGames` omitted `app_id`, so a self-exclusion filter comparing it matched every
row and excluded nothing. `getAllGames` omitted `provider_id`, then `icon_hash`.
**Signature:** `undefined !== anything` is true, so the filter silently does nothing.
**Fixable?** YES — mechanically detectable. A lint cross-referencing properties read off
a row against the columns in its query would have caught all four, no model involved.

### A1b. The same family, four times in ONE module (Epic provider)
`json.response.records` where the API returns `records` at the top level — the sync
reported a library of ZERO games as a successful run. `json.results` where the catalog
answers with an object keyed by catalogItemId. A catalog request with no Authorization
header, whose every 401 was reported as "not a game". A catalog queried by the derived
integer instead of Epic's hex GUID. Each had `?? []` or a bare `return null` downstream
turning a broken request into an ordinary empty result.
**Running total for this family across the project: 12.**
**Fixable?** YES, and it is now clearly the highest-value target. A rule that a response
shape must be ASSERTED rather than optional-chained would have caught all twelve.

### A10. Integer conversion of a non-integer identifier (1, severe)
`parseInt(catalogItemId, 10)` on Epic's 32-character hex GUIDs. "0854f1cf…" becomes 854.
571 distinct catalog ids collapsed onto 213 values, silently merging 358 games onto
shared rows. Found by checking the id space, not by reading the code — as a sync it
looked like it worked.
**Fixable?** PARTLY — the brief never warned about it because Claude had not thought of
it either. A house rule ("an identifier from an external system is a string until proven
otherwise") would help.

### A3b. Correct code left unreachable — the repair loop's own guard (1, severe)
Asked to close a hole where a DELETED test file went unreported, vcode wrote
`diffTestFiles` correctly, exported it, imported it into src/index.ts — and never called
it. The buggy inline loop it was written to replace stayed in the code path, so the
guard still printed "no test files modified" while a test sat deleted. Deleting the
failing test is the single most effective way to turn a suite green: the guard shipped
blind to the exact cheat it exists to catch, while printing assurance that a check had
run. Third occurrence of this family.
**Found by:** reading the diff and asking what happens to a key present in only one map.
The feature had already PASSED an end-to-end test — green suite, honest report, correct
attempt count — and would have been signed off on that evidence.

### A2. A value that only works in tests (1, severe)
`recordFeedback` defaulted the provider to the literal `"fixture"`. Every real
three-argument call violated the foreign key. Fifty tests passed because every test
supplied a provider explicitly.
**Fixable?** PARTLY — house rule states it now; automatic detection is harder.

### A3. Code correct in isolation, unreachable in situ (2)
The GOG genre-recovery branch sat behind a query excluding exactly the rows it tested
for. The self-citation fix was inert because of A1.
**Fixable?** PARTLY — a coverage gate catches a branch no test path reaches.

### A4. Silent no-ops from JavaScript semantics (4)
An extra argument to a one-parameter function (the 1500ms rate limit, discarded).
`Math.max(1, Math.min(NaN, 1000))` is NaN, which SQLite reads as no limit.
`opts.delayMs || 500` returns 500 when the caller passes 0.
**Fixable?** YES — all lintable patterns.

### A5. Wrong field name against a real API, self-consistently (1)
Mapped metacritic to `data.metacritic_score`; the real field is `data.metacritic.score`.
**The brief said `data.metacritic.score`.** It then invented the same wrong field in its
own test fixture, so code and test agreed and the suite went green.
**Fixable?** NO. A correct instruction, correctly stated, ignored. This is the model-size
residue. Only a live run against the real API catches it.

### A6. Imports its own database instead of taking one (1, severe)
`syncGog` imported `db.mjs`, so `npm test` wrote fixtures into the real 715-game
database while asserting against an in-memory copy that never saw them.
**Fixable?** YES — house rule, and detectable.

### A7. Skipped tests it was explicitly asked for (5 occurrences)
Three of the first seven veegame tasks, then TWICE MORE on the vcode repair-loop task —
where the brief named the assertions explicitly and it skipped them anyway, then skipped
seven more named cases on the follow-up.
**Fixable? NO LONGER CLEAR.** This entry previously read "apparently yes, it stopped once
briefs specified the assertions". That was wrong: it stopped for a while and resumed. The
correction matters more than the original claim — a deficiency that appears fixed after a
handful of tasks may just be quiet.

### A8. Tests asserting the opposite of their own titles (2)
`"Rust with only UnsupportedAntiCheatConfiguration is 'poor' (no signal either way)"` —
named the contradiction in the title and asserted `poor` anyway. Also asserted the median
of 10h and 20h is 10h.
**Fixable?** UNKNOWN — possibly a reasoning-depth limit.

### A9. Fixtures accepting a field and never writing it (3)
`createDB` accepted `lastPlayedAt` and omitted it from the INSERT; `createIdentityDB`
did the same with `playtimeStatus`. Same family as A1, in test code.
**Fixable?** YES — same lint as A1.

---

## B. UNATTEMPTED — Claude did it without trying vcode

Assumed deficiencies. Each should be tested before being believed.

| Work | Lines | Why Claude did it | Was it specifiable? |
|---|---|---|---|
| `server/vocabulary.mjs` | 114 | Derived from measuring two tag vocabularies | Probably — the analysis was Claude's, but the module itself is specifiable once the findings exist |
| True idf-weighted cosine in `taste.mjs` | ~40 | measure → change maths → re-measure, three rounds, target changing each time | Unclear — the brief could only be written after measuring |
| 3×2 grid + collapsible library | ~40 | vcode was mid-task on another file | YES — no excuse |
| Deck/GOG/vocabulary fetch + migration scripts | ~300 | operational one-offs | YES — ordinary scripts |
| Merged-view wiring in `index.js` | ~30 | VP was waiting | YES |

**Honest reading:** at least three of these five were plainly specifiable and simply were
not delegated. This ledger currently OVERSTATES vcode's limits.

---

## C. Claude's own errors (not vcode's, recorded for symmetry)

- Specified GOG's `tags`/`developers` as arrays of strings; they are arrays of objects.
  Cause: probed the API through a `.map(x => x.name || x)` and read the transformation as
  the raw shape. vcode implemented the wrong spec faithfully.
- Stored Valve's Deck tokens without `display_type`, losing whether each test PASSED or
  FAILED, which produced self-contradicting evidence on the card.
- Demanded Rust/GTA V/PUBG be *eligible* for handheld when the honest verdict is
  *unrated* — no ergonomic data exists for them.
- Copied GOG terms into both the Genre: and Tag: namespaces, making 51% of every GOG
  game's features unmatchable.
- A patch script printed "added game_identity to db.mjs" after a `replace()` whose anchor
  never matched — reported success without verifying, and was believed for three commits.
- An `&&` chain whose heredoc failed still ran `git add -A`, committing vcode's
  half-written Epic files under a commit message describing this ledger.

---

## D. vcode limitations found here (kept — these ARE about the tool)

- **The repair loop only engages when `editedPaths` is non-empty**, so a task that
  changes files entirely through bash (`rm`, `sed`, `mv`) never triggers it. Found by
  testing it: an agent told to delete a file did so via bash and the loop never ran.

## E. Where vcode did well (the ledger is worthless if it only records failures)

- **`repair-loop.ts` got the subtlest rule right unprompted by example:** `exitCode === null`
  returns false, so a test-suite timeout does not send the model off "fixing" working
  code. That is the absence-vs-fact distinction, applied correctly in code it wrote alone.
- **The non-game entitlement filter needed NO fixes** — 190 tests, straight through. The
  brief carried verified endpoints, a measurement to cite, and named test cases.
- **Pure modules in isolation are consistently good.** The failures cluster at
  INTEGRATION: where in an existing 2,000-line file the call belongs, and what shape the
  data actually has when it arrives.

## Standing rule from here

Default to giving it to vcode, including measurement work, so the ledger records
demonstrated deficiencies rather than assumed ones. Where Claude codes directly, record
WHY — and "it was faster" is an admission, not a justification.
