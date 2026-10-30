**Fix: one film's finish step can no longer replace a clip another film recorded (#379).**

A finish step now writes to `renders/<project>/clips/<film_id>/`, and a retry to `<film_id>/r<gen>/`. Core sends the key as `output_key` with or without presigned URLs. It takes effect once the backend and the module honour `output_key`. Until then they write the shared key, and adoption still reads it behind the #583 hash.

A resubmit no longer adopts another film's finished clip. Each film runs its own steps.
