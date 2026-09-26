### fix(core): drop musetalk-the-provider from the legacy finish heuristics and CI roots

musetalk is ruled out permanently as a lip-sync provider and its RunPod
endpoint is gone. The two legacy binding-name heuristics in `film-model.ts`
(`finishStepOutputKey`, `finishStepAppliedTag`) drop the `MUSETALK`
alternative and keep `LIPSYNC`; no module binding named `*MUSETALK*` exists
in any consumer, so no live derivation changes. CI stops checking out the
archived `vivijure-musetalk` consumer and drops it from
`VIVIJURE_CONSUMER_ROOTS`; `handler.py`, the only `.py` basename that repo
shared with a core comment, still resolves in four remaining roots.

Comments that asserted a live musetalk are corrected, including four that
carried counts which had gone false. Lip-sync as a concept is unchanged:
`infinitetalk` is the live audio-driven path and the generic `LIPSYNC`
vocabulary, tags and fixtures stay.
