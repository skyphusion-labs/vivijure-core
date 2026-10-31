**Fix: a Durable Object disconnect is retried, not terminal (vivijure-cf#1152).**

The platform text says to retry, and the classifier read it as deterministic, so one disconnect failed a film and dropped its paid clips.
