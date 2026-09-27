### feat(video-finish): mint the partialUrls pool, and give every assemble URL a TTL that outlives the job

Chunked assemble (vivijure-cf#784, container side in cf#801) was **inert**. The container takes its
single-pass path whenever `partialUrls` is absent, and no Worker ever sent one, so the shipped
container was byte-for-byte the old behaviour and peak disk was still 3-4x total input.

`FinishPayload` now carries `partialUrls`, and both assemble sites mint one: `enterAssemblePhase`
and the scatter gather. The two **mux** sites do not, and must not: they send `remuxAudioOnly`,
which is single-pass by definition.

**Pool size is provable rather than estimated.** The container flushes only a non-empty batch, so
every batch holds at least one clip, so batches can never outnumber clips. `clips.length` pairs is
an exact upper bound needing no `HEAD` probe and no byte accounting on the Worker side. Presigning
is local HMAC with no network, so the unused tail costs almost nothing and expires unread.

**The TTL is the part that would have failed in production.** Every presigned URL in an assemble
payload was minted at a hardcoded `1800`. Under single-pass that was sound, because every clip is
downloaded in the first seconds of the job. Chunking invalidates it in two places, and only one of
them is new code:

- the final pass concatenates the partials, so `partial_gets[0]` is minted at `t0` and first READ
  at `t_final`; a TTL sized to the join has already expired by the time it is used;
- batch N downloads its own clips only after batches `0..N-1` have normalized through libx264, so
  the **input clip GETs** must outlive the whole job too. That line of code did not change; its
  assumption did, which is exactly why it would have survived review.

A comment cannot fail and a README cannot fail, so this is a constant plus an assertion.
`ASSEMBLE_PRESIGN_TTL_SECONDS` is checked against `ASSEMBLE_MAX_JOB_SECONDS` at module load and
again inside `mintPartialUrlPool`, which **throws rather than clamping**: a caller passing 1800 has
a wrong model of the job, and silently widening it would hide the mistake the check exists for.

**The same constant is the give-up horizon, deliberately.** `AssemblePollState.submittedAt` was
recorded on every tick and never read (grep-zero), and `notFoundStreak` resets to 0 on any
`pending`, so a job whose presigns had expired polled **forever** -- which is why a short TTL
presented as a hang rather than an error. Past the horizon the URLs are dead and the job provably
cannot succeed, so it now fails with that reason. Tying the TTL and the horizon to one number is
what stops them drifting: shorten one and you shorten the other.

Batch partials are deleted on a terminal outcome, either way. Keys are deterministic, so cleanup
needs nothing off the job doc and cannot be orphaned by a lost field; a cleanup miss warns and
never fails a film that rendered.

`tests/partial-url-pool-301.test.ts` asserts the **TTL alongside the key**, because the key set was
never wrong and a key-set assertion is structurally blind to this bug. The wiring rows drive
`advanceFilmJob` to a real submit and assert against the JSON body actually POSTed to
`/async/finish`, with the stub presigner baking the requested TTL into the URL it returns, so the
submitted payload is its own witness. Verified red on both halves of the real defect: reverting the
clip presign to 1800 fails 1 row, dropping `partialUrls` from the payload fails 2.

Files: `src/video-finish-assemble.ts`, `src/film-orchestrator.ts`, `src/scatter-orchestrator.ts`,
`tests/partial-url-pool-301.test.ts`.
