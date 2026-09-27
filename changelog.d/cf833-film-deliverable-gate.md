### fix(film): a film that is not in R2 FAILS, instead of completing on a guessed key

`resolveFilmOutputKey` ended with `return defaultFilmOutputKey(job.film_id)`, so it
handed back a truthy key for every job that was neither keyframes-only nor a clips
degrade, probed or not. That guess did not merely mislabel a row. BOTH R2-existence
heals are guarded on the key being FALSY (`transitionToDone` ->
`adoptFilmOutputKeyFromStore`, and the COMPLETED backfill in `renders-db.ts`), so a
key that is always truthy made the two checks written to catch a COMPLETED row with
no artifact unreachable. The helper feeding the gates disabled them.

The resolver now reports only what the job doc records, `filmDeliverableExpected`
carries the "this shape owes no film" question that the `undefined` return used to
carry as well, and `transitionToDone` HEADs the film it is about to stamp on the
renders row: a film that is OWED and is not in R2 is a failed render, not a
COMPLETED row whose download link 404s. Both shapes that legitimately owe no film
(keyframes-only, and the #519 clips degrade) still finish green.

Entry path this closes: `enterMuxPhase` resuming a persisted doc whose `phase` is
`"mux"` but whose `silent_film_key` did not persist sets `film_key = undefined` and
transitions straight to done.

Three fixtures asserted a world they had not built: their fake `R2_RENDERS.head`
answered "nothing exists, ever" while the prose of the cases said the silent film
was in R2. They now model the store the scenario describes.

Refs vivijure-cf#833.
