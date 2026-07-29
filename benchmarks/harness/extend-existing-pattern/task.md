Add support for a `rename` operation to this migration runner.

A `rename` migration should have `type: "rename"`, a `from` column name and a `to` column name, and produce the SQL `ALTER TABLE <table> RENAME COLUMN <from> TO <to>`.

Follow the conventions already used by the existing operations in this codebase. Run the test suite when you are done.
