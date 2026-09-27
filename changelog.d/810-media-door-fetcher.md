### feat(media-door): reach a CPU media door through an in-process Fetcher instead of a hostname

Ruled as option 3 of vivijure-cf#810.

**The shape vivijure-cf#797 specified cannot exist.** This package is a LIBRARY running inside the
`vivijure-studio` Worker, and #797 planned to front the container with a ROUTE on that same Worker
with `VIDEO_FINISH_URL` pointing at it. Cloudflare documents same-zone Worker-to-Worker global
`fetch()` against a route as failing; it succeeds only against a Custom Domain. `tsc` cannot see
that and a deploy would succeed against it, so the door had to stop being a hostname.

`Env` gains an optional `MEDIA_DOOR_FETCHERS`, keyed by the door's URL var so there is one door
vocabulary rather than two. When a door is bound, `mediaDoorFetch` routes through the binding at an
internal origin (`http://video-finish/...`, a LABEL that nothing resolves) and the public origin is
never consulted. The interface is duck-typed on `fetch`, matching `vivijure-cf/src/render-frames.ts`
`FetcherLike`, so a Durable Object stub, a service binding and a test double are all admissible
without importing a Cloudflare type here.

**Three consequences that are each easy to leave out, and each break the feature on their own:**

- **`mediaDoorReachable` now counts the binding.** Every phase gate in the orchestrators
  (`enterAssemblePhase`, mux, gather, clip validation) calls it. Without the binding arm, a studio
  with the container bound and `VIDEO_FINISH_URL` unset degrades to "tier not installed" while the
  container sits there working.
- **POLL goes through the binding, not only SUBMIT.** `pollVideoFinishAsync` used a raw global
  `fetch` against per-box hostnames. Shipping only the submit half would have posted the job into
  the container and then polled three authoritative NXDOMAINs for the answer, hanging every job as
  `missing` until the not-found streak gave up: a worse failure than the one being fixed, and
  harder to read. With a bound door there is exactly ONE target, because a DO stub is a single
  addressable instance and there are no peers to ask.
- **A missing bearer no longer fails closed on the bound path.** The bearer authenticates a request
  that crosses the public internet, and this one never leaves the isolate's request graph. A token
  is still SENT when the host set one (`mediaFinishHeaders` attaches it at the call site), so a
  container image configured with `LOCAL_FINISH_TOKEN` keeps working unchanged.

**The public path is untouched.** No binding means the previous behaviour exactly, fail-closed
bearer included, and that is asserted rather than assumed.

Adjacent, fixed in passing: `mediaDoorUrl` was used directly as a reachability gate for
`AUDIO_MIX_URL` and `IMAGE_PREP_URL`, which would ignore a binding for those doors. Now
`mediaDoorReachable`.

The not-found streak is deliberately KEPT on the bound path. Async job state still lives in
container process memory (vivijure-cf#784 item 2 is not done), so a container restart or instance
eviction loses it and a 404 remains "possibly transient" rather than proof the job never existed.
Tightening that debounce belongs with externalising the state.

`tests/media-door-fetcher-810.test.ts` replaces `globalThis.fetch` with a spy that THROWS on
several rows, so a surviving edge hop fails the suite instead of quietly working in dev and failing
on a same-zone deploy; asserting only "the binding was called" would pass with a stray global fetch
still in the code. The wiring row drives `advanceFilmJob` with `VIDEO_FINISH_URL` and
`MEDIA_FINISH_TOKEN` both unset and asserts the film reaches an assemble submit carrying the #301
pool, so the two changes are shown to compose. Verified red: dropping the binding arm from
`mediaDoorReachable` fails 3 rows; dropping the poll binding fails 1.

Files: `src/media-finish-auth.ts`, `src/video-finish-assemble.ts`,
`src/platform/orchestrator-context.ts`, `src/film-orchestrator.ts`, `src/bundle-assembler.ts`,
`src/index.ts`, `tests/media-door-fetcher-810.test.ts`.
