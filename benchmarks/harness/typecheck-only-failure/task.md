`npx tsc --noEmit` reports errors in this project, even though the test suite
passes. Make the type check clean.

Fix the types properly: do not use `any`, a non-null assertion (`!`), or a
`@ts-ignore` / `@ts-expect-error` comment.

The behaviour documented in the JSDoc must hold. A missing user, or a user with
no email address, must throw an `Error` whose message contains the id that was
asked for.
