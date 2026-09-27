### docs(runpod-job-log): the "filed separately" satellite reference pointed at nothing, and half of it is moot

`src/runpod-job-log.ts` explained, correctly, that the satellite endpoints emit no structured
`error_type` and that this parser returns `undefined` rather than guessing a class from prose. It then
said fixing them was "a vivijure-upscale / -audio-upscale change, filed separately."

**It was not filed, in either repo.** Measured with a positive control so the zeros mean something
(`vivijure-cf` returned 23 open under the same command): `vivijure-upscale` 0 open / 18 closed, none
about a structured marker; `vivijure-audio-upscale` 0 open / 9 closed, same.

- **video: now filed**, `skyphusion-labs/vivijure-upscale#126`. The repo is live, but its RunPod
  endpoint is currently absent, so that work is **deferred** rather than actionable today.
- **audio: MOOT, not blocked.** `vivijure-audio-upscale` was archived 2026-09-26 and is read-only, so
  it cannot receive an issue at all.

**Four independent paths read zero for the audio door**, which is what makes it a retirement already
taken rather than one to decide: the repo is archived; `vivijure-cf` carries no `src/` reference and no
service binding for it, only CHANGELOG, docs and tests; and RunPod lists **two endpoints in total**,
`vivijure-wan-train` and `vivijure-backend` (`total: 2, truncated: false`), with no audio-upscale
among them. One zero is a blast-radius reading; four is a conclusion.

The absent upscale endpoint **corroborates cf#757 independently** -- that issue reports
`finish-upscale` bound to an endpoint that no longer exists, and the endpoint list agrees.

The comment now records the audio half as moot on purpose rather than tracking it somewhere it can
never be done, because **an issue tracking impossible work reads exactly like an issue tracking
neglected work.** A citation nobody checks is a control that reads as present, which is the same class
as a guard that cannot fail: it satisfies a reader without doing anything. Fifth stale
cross-reference found in this sweep.
