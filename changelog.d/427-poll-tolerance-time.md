### Fix: fast client polls can no longer use up the poll tolerance (vivijure-core#427)

The transport tolerance for a clip poll (#719) and a keyframe poll (#426) counted polls: three failures in a row failed the shot or the film. Polls come from the cron, one a minute, and also from every client poll of the render. A client with the planner open polls every 8 s, and an agent can poll faster. So three failures could land within seconds, and a short R2 or module blip failed a healthy render.

Now a run of consecutive transport failures fails the poll only once it has lasted both `CLIP_POLL_MAX_ATTEMPTS` (3) polls and `CLIP_POLL_TOLERANCE_SECONDS` (120 s) of wall time, measured from the run's first failure (`ClipShot.poll_failing_since`, `FilmJob.keyframe_poll_failing_since`). A clean poll ends the run. 120 s is two cron intervals, so a film that only the cron drives fails on the same tick as before. The count stays as a floor, so a cadence slower than the window still gets its three tries. The failure text now says how long the run lasted. New export: `pollToleranceSpent`.

**For a host.** A render polled faster than once a minute now holds through a transport blip of up to 120 s instead of failing after three polls.
