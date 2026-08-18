### feat(film): parallel keyframe invokes

`startFilmJob` fans the keyframe hook across `KEYFRAME_PARALLEL`
contiguous `shot_id` chunks (default 4) on one film job. No
scatter-* parent. Hosts set `KEYFRAME_PARALLEL` on the orchestrator
env (plaintext integer string). `1` (or a single-shot film) keeps
the historical single invoke + `keyframe_poll` path. Pending chunks
store tokens on `keyframe_polls`; advance polls all and merges
outputs (last-write-wins on a duplicate shot_id). A failed invoke
or poll fails the film. Cancel stops every in-flight token.
