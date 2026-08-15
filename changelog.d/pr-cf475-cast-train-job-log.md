### feat(cast-train): cast LoRA training records a runpod_job_log row (vivijure-cf#475)

Cast LoRA training was the one GPU path in the estate with no job record at all. Measured from the
money, not inferred: the `vivijure-wan-train` endpoint billed 14.5% of GPU spend on 2026-08-01 and
21.9% on 2026-08-02 with ZERO rows in `runpod_job_log` on either day. Absent rather than
mis-attributed, and absent in the flattering direction, since every row that IS in the table is
correct, so any total built on it reads clean and is simply low by the training share.

The cause was architectural. `recordRunpodJob` lived in `vivijure-cf/modules/_shared/`, written when
only module workers submitted to RunPod; cast training submits from core, which sits UPSTREAM of that
file and could not reach it. The recorder therefore moves into core as `src/runpod-job-log.ts`, which
is the fix cp#321 already ruled for `runpod-route.ts`: move the implementation into core, have both
sides import it, do not write a second one. The carried body is byte-identical to the vivijure-cf
file apart from one substitution, `D1Database` to the platform `Database` type.

`RunpodResult` gains an optional `backend` tag (`runpod-wan-train` / `runpod-render` / `local-door`),
set by the function that MAKES the routing choice and never re-derived by a caller. A submit or an
observed-terminal poll on a RunPod backend writes a row labelled `cast-train-wan` or
`cast-train-sdxl`, carrying RunPod's own `executionTime` / `delayTime`. A local-door train is our own
iron and records nothing; an untagged result records nothing, so a caller that forgets produces a
findable gap rather than a row invented against a guessed endpoint.

Not claimed: a job that ages out of RunPod retention before any poll observes it terminal still
leaves its row at `submitted` with no seconds. `reconcileOpenRunpodJobs` is the mechanism for that
and is now reachable from core; wiring a cast-train pass through it is follow-on work.
