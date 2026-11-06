**Feat: a driven shot keeps its planned length on every door, by the cheapest means the door allows (vivijure-cf#1338).**

After core#464 stopped padding every driven line to 3s, a door that sizes its clip from the line delivered the line's length rather than the plan. Measured on InfiniteTalk: a shot planned at 2s, with a 0.43s line, delivered 0.36s. Now:

- **A door that bills per clip** (it declares `ui.cost_usd_per_clip`, every entry a `{ usd }` and none keyed by `seconds`, so a longer clip costs no more) gets its driving line padded with silence to the shot's planned seconds, so the extra seconds cost nothing. The pad is added after the dialogue module's trailing-silence cut.
- **A door that bills by length** (a per-second price, a per-clip price keyed by duration step, or no price) gets no pad, because the pad would be billed. Assembly holds its clip's last frame to the planned seconds instead. Each clip in the `/finish` request may carry `holdToSeconds`, which video-finish honours from vivijure-cf#1338's container. An older container ignores it.
- Neither path goes past the door's `max_seconds`, or the 15s line cap for a pad.

`ModuleUi` gains `cost_usd_per_clip` and `cost_usd_per_second`, already declared by the doors. New pure helpers: `doorBillsPerClip`, `drivenLineFloorSeconds` and `assembleHoldSeconds`.
