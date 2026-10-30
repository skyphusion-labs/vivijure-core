### fix(video-finish): a full finish tier is a wait, not a failed film

A video-finish door that answers 429 on submit no longer fails the film. The phase stays `assemble`, `mux` or `gather`, and the sweep retries at 30s, 60s, 120s, 240s, then every 300s. Past `ASSEMBLE_CAPACITY_MAX_WAIT_SECONDS` (6 hours, the same as the job horizon) the film fails with an error that names capacity, and the clips stay on `finish_unavailable` as retained. `FilmSummary.finish_waiting` says why the phase is not moving.

Any other refusal stays terminal, and its error now carries the door's text with URLs removed, in place of a bare status.

A submit carries `x-vivijure-finish-affinity` with the film id, so a door can send a retry and the next leg to one instance. A door that ignores the header behaves as before.

Publishing this package, and moving the studio pin, are separate from this commit.
