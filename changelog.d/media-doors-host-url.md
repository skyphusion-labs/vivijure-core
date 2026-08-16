### feat(media): every CPU media door is a host URL, no baked origin

Delete `VIDEO_FINISH_SUBMIT`. There is no default origin; an unset
`VIDEO_FINISH_URL` turns the tier off. The same shape covers
`AUDIO_MIX_URL`, `AUDIO_BEAT_SYNC_URL`, and `IMAGE_PREP_URL`.
The `*_VPC` bindings are gone from Env. Unset = degrade / skip.

Helpers: `mediaDoorUrl` / `mediaDoorFetch` / `mediaDoorReachable`.
`videoFinish*` stays as a thin wrapper. Degrade copy says
`VIDEO_FINISH_URL unset`, not `VPC unbound`.
