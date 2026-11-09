### Fix: a pending keyframe poll no longer cancels a finished job and loses its output (vivijure-core#493)

The backend writes each keyframe PNG to R2 before its job returns. So a healthy job always has a window where R2 holds the full set and RunPod still says IN_PROGRESS. The pending-poll adopt (#129 sibling, which exists for an envelope that freezes at IN_PROGRESS) ran on the first poll in that window. It cancelled a job that had finished, and it lost everything only in the job output, including the plate count record. Measured on vivijure-core#493: RunPod job `2092b5e5-...-u1` was CANCELLED with a full output carrying `plate_count`, and its studio row had none.

Now the first pending poll that sees the full set stamps `keyframe_r2_full_at` and holds. The adopt runs on a later pending poll once `KEYFRAME_R2_ADOPT_GRACE_SECONDS` (120 s) have passed. A healthy job returns inside that window and takes the normal path. A frozen envelope is adopted about 2 minutes later than before, still far inside the 20 minute stall ceiling. An adopt also keeps the outputs that sibling keyframe jobs already returned, which the parallel path parks, so those shots keep their records instead of taking the bare R2 key.

**For a host.** `FilmJob` gains an optional `keyframe_r2_full_at`. A keyframes-only preview whose envelope freezes finishes up to about 2 minutes later. No contract change.
