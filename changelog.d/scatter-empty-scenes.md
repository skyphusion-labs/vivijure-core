### fix(scatter): fail loud when the bundle has no storyboard scenes

A scatter whose tar had no parseable `storyboard.yaml` started N
empty-scene films. Keyframe then said `missing: ` (empty). Scatter
now uses planner scenes when the bundle yaml is empty, and refuses
a shard that matches no shots.
