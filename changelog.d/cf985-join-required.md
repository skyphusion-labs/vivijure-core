### fix(film): a missed join or an unread song fails the film (cf#985)

A dead concat door used to mark the film done and hand back the loose clips. The clips stay in R2, finish_unavailable still names them, and the phase is failed.

A staged song is read by beat-sync before assemble and before mux. When that read does not succeed, the film fails and the error starts with "beats were not read". A job that already has beats_read set is left alone. A film with no song still finishes on the silent cut when the mux tier is absent. A staged song whose mux door misses fails, so the song stays required and the silent cut is not called done.

Publishing this package, and moving the studio pin, are separate from this commit.
