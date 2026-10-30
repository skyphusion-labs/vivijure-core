**Fix: one film's finish step can no longer replace a clip another film recorded (#379).**

A `shot_named` finish step now writes to `renders/<project>/clips/<film_id>/`, and a retry to `<film_id>/r<gen>/`. Core sends the key as `output_key` with or without presigned URLs. Adoption reads the film's own key, then the shared key, behind the #583 hash. Another film's folder is never read. It takes effect once the backend honours `output_key`. Until then it writes the shared key as before.

A resubmit of the same inputs runs its own steps. An `append_suffix` step is not changed: it derives its key from its input clip, so two films with the same shared input still share its output (#385).

`archiveExistingClipTakes` streams now. It called `arrayBuffer()`, so a large clip would exceed an isolate's memory, and its best-effort catch hid that.
