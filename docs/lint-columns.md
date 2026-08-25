# lint:columns — status and honest limits

Detects the most common defect this harness produces: code reads a property off a
database row that the query never SELECTed. An absent column is `undefined`, and
`undefined !== anything` is true, so a filter written to exclude something excludes
nothing, raises no error, and looks like it works. 11 of ~29 defects in the first project
were this shape.

## What works

- Catches the real defects. Verified by reintroducing an actual shipped bug into
  veegame's `recommend.mjs` — `provider_id` read but not selected — and confirming it is
  reported at the right line.
- Handles multi-line and concatenated SQL, which is how real queries are written.
- Quiet on `SELECT *` (nothing can be concluded) and on correct single-scope code.

## What does NOT work yet — do not gate a commit on this

**Scope over-reach produces roughly one false positive per file.** `findFunctionScope`
returns too wide a range, so property reads belonging to other functions are attributed
to whichever query it last saw. On veegame's `recommend.mjs` it reports `categories,
developer, genres, icon_hash` against a three-line query that selects one column.

The fix is to bind reads to the VARIABLE the query was assigned to — follow
`const rows = db.prepare(...).all()` to `rows`, and to any iteration variable bound from
it — rather than sweeping the enclosing scope. Until that lands this is a
run-it-and-eyeball tool, not a CI gate. A false positive costs a real investigation and
teaches people to distrust the check, which is worse than the defect it catches.

## Two lessons recorded, both about the verification and not the code

1. The first version passed 8 unit tests and caught **0 of 2** known defects, because its
   final guard (`isLikelyPropertyRead`) tested whether a bare property name contained a
   dot — never true. A check whose guard rejects everything reports "nothing found" and
   is indistinguishable from a clean codebase.
2. The first *probe* used single-line SQL and reported success. Real queries are
   multi-line concatenations, and against real files the scanner found nothing — including
   a defect deliberately put back. **The verification was simplified in exactly the way
   that hid the gap**, which is the same mistake this lint exists to catch, committed
   while building it.
