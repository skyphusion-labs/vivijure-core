### fix(film): a missed join or an unread song fails the film (cf#985)

A dead concat door used to mark the film done and hand back the loose clips. The clips stay in R2. finish_unavailable names them as retained, not as delivered, and the phase is failed. film_key stays unset.

A staged song is read by beat-sync before assemble and before mux, under the film's own job id. A transient miss stays in phase and retries up to the finish cap. A permanent miss, or a transient miss that has used that cap, fails the film and the error starts with "beats were not read". Both beat-sync doors classify their own miss: the module door reports the invoke result, and the direct AUDIO_BEAT_SYNC_URL door separates transport from content, so a non-2xx, an unreadable body and a rejected fetch retry while an unset door and an answered 200 that is not a plan stay permanent. A 502 carrying an error page used to throw past the attempt counter, so the cap never engaged on that shape. A job that already has beats_read set is left alone. A film with no song still finishes on the silent cut when the mux tier is absent. A staged song whose mux door misses fails. The silent cut stays in R2, the notice is render.failed, and that cut is not stored as film_key.

Publishing this package, and moving the studio pin, are separate from this commit.
