### fix(render): single-source the `output_json` payload across its writers (core#205)

- `markFinishDone` writes `output_json = ?` UNCONDITIONALLY (not `COALESCE`, unlike `output_ms` and
  `finish_elapsed_ms` in the same statement), so whichever site writes last takes the whole column.
  The payload was built in several places and only ONE of them derived it from the poll view, so a
  field added to the view was silently absent from the row anyone queries. That already cost
  cf#549's `film_finish` sidecar (core#203).
- `filmDonePayload` / `scatterDonePayload` (`src/render-output-payload.ts`) are now the single source
  for the four sites that hold a job doc. `render-adopt` stays hand-built ON PURPOSE and is pinned by
  a test: it has no job doc and its key set is a different CONTRACT, not a drifted copy. Folding it
  in would have bent the shape to make the writer count come out at one, and a refactor that swallows
  a genuinely different contract to make a number look clean is how the next drift hides.
- The keys the finalize writer cannot reach are asserted as an ENUMERATED DELTA
  (`["clip_deliveries", "clips", "model"]`), not as an absence. An absence check would keep passing if
  the builder later stopped emitting all three.
- **The writer population is FIVE, not the three the issue names**, derived by UNION of five sweeps
  (36 `output_json` lines, 12 `outputJson`, 3 `markFinishDone` call sites, 4 `updateRenderFromView`
  call sites, 15 `output_key:` literals). Derived by intersection it would have been three, and the
  broken writer drops out of its own population.
- **Site 4 changes the issue's story and is worth more than the fix.** core#205 says scatter "happens
  to survive because `updateRenderFromView` runs after `finalizeScatterDone`". It survives because
  that later writer is a SECOND HAND-BUILT OBJECT restating the same three keys: two independently
  maintained duplicates agreeing, not an ordering guarantee. **Anyone acting on the issue's version
  would have hardened the ordering and left the actual fragility untouched.**
- **The five are not uniformly proven, and this is the qualification to carry.** Three further
  statements touching the column were screened OUT by REASONING, not by test:
  `setCloudAnimateProgress` and `setHybridProgress` (both terminal-guarded) and
  `setRenderAudioOutput` (a `json_set` merge). Those exclusion arguments are ARGUMENTS, not
  assertions, and the checkable form of the risk is that **no test in this repo would fail if either
  argument turned out to be wrong.**
- Found live while writing the acceptance probe: `keyframes_incomplete` was in the poll view and
  absent from `transitionToDone`'s hand-built payload, and on the single-film path that write is the
  LAST writer of the tick. A film that dropped keyframes and shipped anyway recorded the loud degrade
  in the view and lost it from the row. The probe is that field, so it is a real value rather than a
  synthetic one.
