### fix(clip-validate): an unreadable clip body is a skip, and a skip stops disabling Layer 1

`clip-validate.ts` promises in its own docstring that "an unreadable artifact is a
'skip' (transient), not a fail, so a blip cannot false-reject a real render". It
honoured that for two of the three ways an artifact can be unreadable and not for the
third: when HEAD said the object exists but a ranged GET came back empty,
`locateStructure` broke out with `ftypOk: false` and `judgeClip` reported "not a valid
mp4 (no ftyp/moov box tree); corrupt or wrong format", failing the shot on a positive
claim about CONTENT derived from a read that returned no content.

**The order is the subtlety, and it is why this is not a one-liner.** The byte floor
is judged FIRST, so a 0-byte or truncated clip still FAILS on its size rather than
being excused as unreadable: an empty body and an unreadable body are
indistinguishable at the transport level, and size is the only thing that separates
them. Same order, for the same reason, as `validateFilmArtifact` (cf#835).

**And the caller had to change in the same breath.** `validateDoneClips` wrote the
skip straight into `shot.validated`, whose truthiness is the idempotence guard, so
turning this FAIL into a SKIP without touching the caller would have converted a wrong
refusal into a permanent unchecked pass: the shot would never be structurally
validated again. That is exactly core#30's defect, proven in Layer 2 in August, quietly
present in Layer 1 the whole time. `validated` now takes only a VERDICT, a skip
re-runs next tick, and the reason lands on `validated_unmeasured` in the vocabulary
cf#856 established one layer up (written only when it changes, cleared the moment a
verdict lands).

Not added: a film-level projection for Layer 1 skips. Layer 2's `content_validation`
exists because a pixel gate that could not run is invisible otherwise, whereas a Layer
1 skip means the artifact itself could not be read, and the deliverable gates from
cf#833/cf#835 plus the #697 duration gate act on that class downstream. One signal per
fact; a second key restating a condition the payload already reaches by another route
would be paperwork.

Refs core#310, core#30, vivijure-cf#856, vivijure-cf#835, core#523.
