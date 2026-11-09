### Fix: a video-finish submit that never answers is bounded (vivijure-core#308)

The capacity wait, the core#377 transport hold and the 6 h job horizon all start after `submitAsync` returns, and `submitAsync` sent its request with no deadline. A door that never answered started none of them, so `assemble` sat with no error, which reads the same as work in progress (vivijure-cf#841, film-40e0cd09, about 4.5 minutes before the platform gave up first).

Every request to the video-finish door now has a deadline, `FINISH_DOOR_TIMEOUT_SECONDS` (60). The transport is given an `AbortSignal` that fires at the deadline, and the call is also raced against it, so a transport that ignores the signal is bounded too. A submit past the deadline is `unreachable`: with an affinity holder it takes the transport hold (15 minutes with backoff, then it fails by name), without one it fails the tick by name, and the detail says `no answer within 60s`. The status poll is bounded the same way, and a poll past the deadline is a miss counted by the not-found streak, as a thrown transport already was.

The 60 s is documented, not measured: the container library vivijure-cf runs (`@cloudflare/containers` 0.3.7) gives up a start after 8 s for the instance plus 20 s for the ports, 28 s, and vivijure-cf overrides neither, so a request still open past that is not a slow cold start. 60 s is about twice that ceiling. No cold-start latency for this door is recorded.

**For a host.** Nothing to change. A film whose finish door hangs now says so within a minute and is held or failed by name, instead of sitting in `assemble`.
