`formatLegacy` in src/format.js is deprecated. Remove it and migrate every
caller to `format`.

The output of every caller must be byte-for-byte what it is today. Run the test
suite when you are done.
