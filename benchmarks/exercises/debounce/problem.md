In a file named `solution.ts`, export a function `debounce<F extends (...args: any[]) => void>(fn: F, waitMs: number): (...args: Parameters<F>) => void`.

Behavior:
- Returns a wrapped function. Calling the wrapper schedules `fn` to run after `waitMs` ms of inactivity.
- If the wrapper is called again before the timer fires, the previous timer is cancelled and a new one is scheduled.
- `fn` must be called with the arguments of the *latest* invocation.
- `fn` is never invoked synchronously.

This is a standard leading-edge-false debounce (trailing call only). No additional options.

Use the `write_file` tool. Export `debounce` as a named export.
