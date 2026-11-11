### Feat: a lined shot moves off a door whose clip floor leaves a silent-mouthing tail (vivijure-cf#930)

Conrad's ruling (2026-11-11): a per-shot motion door applies to that one clip only, and the film's door stays the default for every other shot.

A shot qualifies when all of these hold:
- it has a line and no door of its own;
- its film door is driven by audio and priced by length;
- that door's clip floor runs the clip more than 0.5 s past both the plan and the line (Wan 2.6 makes a 1.4 s line into a 5 s clip).

Such a shot now moves, for its own clip, to the first door in the caller's new `door_fit` list that takes it without a tail. That door must be serving, driven, and pass the shot's `requires` rules (core#507). It gets its config from `motion_configs`. Only `per_shot_motion` is written; `motion_backend` never changes, so every other shot keeps the film door. The line is then padded for the shot's new door.

Nothing is silent. A new job record `door_fit`, projected onto the render row, lists `swapped` shots (from, to, line, plan, the clip the film door would have made). It also lists `tails`: lined shots still left with one, because they had their own door, were offered no substitute, or no substitute fit. A `motion.door_fit` event goes out per shot.

The decision runs once per film, before the first clip. `startFilmJob` takes `door_fit` and `motion_configs`; `startFilmFromKeyframes` takes `door_fit`. Both join the idempotency key only when set, so existing submits keep their keys. New exports: `clipSecondsOnDoor`, `doorTailSeconds`, `pickFitDoor` and the `DoorFit*` types (`src/door-fit.ts`).
