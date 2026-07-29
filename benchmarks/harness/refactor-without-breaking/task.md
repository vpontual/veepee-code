`formatDuration` in src/format.js has grown three boolean flag parameters and is
hard to call correctly. Refactor it to take an options object instead:

    formatDuration(ms, { long, showMs, pad })

Every existing caller in this project must keep working and the test suite must
still pass. Update the callers as part of the refactor.
