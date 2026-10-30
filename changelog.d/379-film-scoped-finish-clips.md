**Fix: one film's finish step can no longer replace a clip another film recorded (#379).**

A `shot_named` finish step now writes to `renders/<project>/clips/<film_id>/`, and a retry to `<film_id>/r<gen>/`. Core sends the key as `output_key` with or without presigned URLs. Reuse goes through `<shot>_finished.latest.json`, and adoption reads the film's own key, then the pointer's target, then the shared key, always behind the #583 hash. It takes effect once the backend honours `output_key`. Until then it writes the shared key as before.

An `append_suffix` step is not changed: it derives its key from its input clip, so two films with the same shared input still share its output.
