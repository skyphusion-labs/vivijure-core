**Fix: a finish retry that succeeds no longer reads as degraded (#399).**

A retried step kept the `passthrough:` tag from its failed attempt in `applied`, and the summary reads that tag, so `finish.degraded` stayed 1 after the step had worked. A retry now drops the retried step's earlier tags and empties the ledger, which reconciles to the new chain. Other steps' tags stay.
