### fix(payload): master, speech and dialogue degrades reach the render payload

The `master` and `speech` degrades were `console.warn` only, so nothing they
recorded ever reached `renders.output_json`. The panel's "completed with limits"
projection reads `finish_unavailable` plus the clip-level `finish` summary, so a
film that was never mastered, or whose speech chain was skipped, was
indistinguishable in the UI from one that got both. The panel was doing its job
correctly on the information it was given.

The correction that makes this small: BOTH RECORDS ALREADY EXISTED on the job doc
and are persisted with it (`job.master.degraded: string[]` written by
`degradeMasterStep` and `applyMasterOutput`, `job.speech_shots[].degraded: string`
written by `advanceSpeechPhase`). This was never a missing channel, only a missing
projection. The third, `dialogue`, is the record cf#834 added.

All three project in the vocabulary the panel ALREADY parses for the clip finish
chain, `{ degraded: <count>, reasons: <string[]> }`, so the frontend adds a parse
per stage rather than a parser per stage. Built in `film-model.ts` and added to
`filmDonePayload` only, per core#205: one builder, no call-site inlining, and both
writers on each path go through it.

The ladder is the contract, and a stage that collapses its states rebuilds cf#549
one field over:

    key ABSENT        the stage was never reached. NOT MEASURED.
    degraded: 0       it ran and ran clean.
    degraded: n > 0   it ran and degraded, and `reasons` says how.

`finish_unavailable` is deliberately NOT widened. Its contract is the video-finish
tier being unavailable at assemble or mux, its `at` and `delivered` are closed
two-member unions, and `film-output-key.ts` keys the deliverable off
`delivered === "clips"`. A master degrade delivers a COMPLETE film that is merely
unpolished; recording it in a field whose meaning is "something was not delivered"
would make that field mean nothing in particular.

Refs vivijure-cf#836.
