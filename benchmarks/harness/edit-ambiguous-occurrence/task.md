In `fetchInvoice` only, stop throwing when the attempt limit is exceeded —
return `null` instead.

The other three fetchers must keep throwing exactly as they do today. Run the
test suite when you are done.
