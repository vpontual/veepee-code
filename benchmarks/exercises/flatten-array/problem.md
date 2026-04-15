In a file named `solution.ts`, export a function `flatten<T>(arr: unknown[]): T[]` that recursively flattens arbitrarily nested arrays.

Examples:
- `flatten([1, [2, [3, [4]]]])` → `[1, 2, 3, 4]`
- `flatten([])` → `[]`
- `flatten([[], [[]]])` → `[]`
- `flatten([1, 'a', [true, [null]]])` → `[1, 'a', true, null]`

Use the `write_file` tool to create `solution.ts`. Export `flatten` as a named export. Do not rely on `Array.prototype.flat(Infinity)` — implement recursion explicitly.
