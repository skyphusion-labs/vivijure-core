### Feat: a failed module poll can say whether another try can help: `retry` (vivijure-core#502)

`applyPoll` decided a clip retry by reading the poll's `error` sentence (`classifyTransientFailure`, then `isClipPollTransportError`). The invoke path already reads a declared `reason` first (#291), but the poll failure arm had nothing structured that names the class: none of `PollFailureOutcome`'s four members means "transient".

The `PollResponse` failure arm gains an optional, closed `retry?: "transient" | "deterministic"` (`PollRetry`, `POLL_RETRY_VALUES`, `isPollRetry`). `applyPoll` reads it first. `transient` drops the dead token and resubmits within `CLIP_SUBMIT_MAX_ATTEMPTS`. Only a module that answered sets the field, so it never takes the re-poll leg that exists for the host's own `/poll` transport errors. `deterministic` fails the shot now. When the field is absent, the prose classifiers decide exactly as before. A value outside the set is logged and treated as absent, never guessed into a class. It is a new field, not `reason`, so the core#306 decision stands: `backend-error` and `cancelled` keep their separate meanings on the two arms.

**For a module author.** Set `retry` only where the condition names the class, the same rule as `reason` on invoke (vivijure-cf#846). Leaving it out changes nothing.
