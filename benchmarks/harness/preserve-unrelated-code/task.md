`stripExtension` in src/paths.js does not do what its documentation says it
does. Fix the implementation so it matches the documented behaviour.

Everything else in that file is vendored code. Leave it byte-for-byte
identical. Run the test suite when you are done.
