**Fix: a good clip that opens differently no longer fails the film (vivijure-cf#1153).**

The content gate failed a shot whenever its first frame differed from the keyframe. A reference door does not open on its still, and a provider can open on an invented shot, so one good clip could fail a film and drop its paid clips. A mismatch now fails only when the noise metric agrees. Otherwise the clip is delivered and named in `content_validation.degraded`, which also now reports the existing `suspect` degrade.
