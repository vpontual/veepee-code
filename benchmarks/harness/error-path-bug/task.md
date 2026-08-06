`parseRange` in src/range.js does not implement the error behaviour its
documentation describes. The happy path is correct; the failure cases are not.

Make the implementation match the documentation. Run the test suite when you
are done.
