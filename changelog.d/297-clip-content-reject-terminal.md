### fix(render-orchestrator): exclude a content-rejected clip from the R2 presence reclaim

Ref: GHSA-hcr9-8jc2-9q4c. The clips-leg instance of the distinction #296 drew on the finish leg.

`reclaimClipsFromR2` selected any not-done shot whose artifact is present in R2, excluding only
`validated === "fail"` (Layer 1, structural). Layer 2, the pixel / keyframe-similarity gate, parks a
`corrupt` verdict on the same `failed` status, and a rejected artifact is by definition still in R2,
since being there is what it was judged on. Its own idempotence flag (`content_validated`) then
suppresses re-inspection, so a shot recovered that way is never re-judged.

The filter now also excludes `content_validated === "corrupt"`, which is the shape the Layer 1
exclusion sitting beside it already had: a terminal state that is a DECISION rather than a delivery
failure is not something artifact presence should overturn. The pre-existing Layer 1 exclusion is why
this is additive rather than novel; the same reasoning simply had no Layer 2 counterpart.

Only `corrupt` is excluded, and that is the load-bearing part. `ok` is a pass and `suspect` is
warn-and-degrade by design, so excluding either would have disabled the #141 recovery for every clip
the content gate has ever inspected. `tests/clip-content-reject-terminal.test.ts` carries a
discriminator over all three verdicts for exactly that reason, asserts the Layer 1 exclusion is
unchanged, and keeps the plain-failed and pending recoveries green. The refusal half was watched
failing first: the reclaim returned an adopted count of 1 where it must return 0, and the shot read
`done` where it must read `failed`.

Files: `src/render-orchestrator.ts`, `tests/clip-content-reject-terminal.test.ts`.
