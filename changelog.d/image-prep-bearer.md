### fix(media): send MEDIA_FINISH_TOKEN on image-prep

`callImagePrep` posted `/portrait/prep` with content-type only. The other
CPU media doors already send `Authorization: Bearer` via `mediaFinishHeaders`.
Image-prep now does the same. Unset stays fail-open. A leftover `*_VPC`
Fetcher is never the transport.
