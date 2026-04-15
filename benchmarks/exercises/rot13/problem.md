In a file named `solution.ts`, export a function `rot13(input: string): string` that applies the ROT13 cipher.

Rules:
- Rotate ASCII letters A-Z and a-z by 13 positions, wrapping around
- Preserve case
- Leave non-letter characters (digits, punctuation, whitespace, unicode) unchanged
- Empty string → empty string
- `rot13(rot13(x))` === `x` for all ASCII-letter strings

Examples:
- `rot13('Hello, World!')` → `'Uryyb, Jbeyq!'`
- `rot13('abc XYZ 123')` → `'nop KLM 123'`

Use the `write_file` tool. Export `rot13` as a named export.
