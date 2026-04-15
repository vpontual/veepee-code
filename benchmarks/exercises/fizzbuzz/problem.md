In a file named `solution.ts`, export a function `fizzbuzz(n: number): string[]` that returns the classic FizzBuzz output for values 1..n.

Rules for each value `i` from 1 to n:
- Multiple of 15 → `'FizzBuzz'`
- Multiple of 3 (but not 5) → `'Fizz'`
- Multiple of 5 (but not 3) → `'Buzz'`
- Otherwise → the number as a string (e.g. `'7'`)

`fizzbuzz(0)` must return `[]`.

Use the `write_file` tool to create `solution.ts`. Export `fizzbuzz` as a named export.
