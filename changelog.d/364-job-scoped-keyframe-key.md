### fix(keyframe): a job-scoped keyframe key stays job-scoped

`isRendersKeyframeKey` now accepts one job segment, `renders/<project>/keyframes/<job>/<shot>.png`.
Before, `own-gpu` and `local-gpu` clip submits copied that key back to the shared canonical key.
Concurrent renders of one project could then overwrite each other again (cf#1059). `listProjectKeyframes` now also finds the stills of the keyframe jobs this film started, so a lost poll still recovers them. It never adopts another job's still.
