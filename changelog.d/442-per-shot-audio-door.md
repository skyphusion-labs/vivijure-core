**Feat: a film can mix a door driven by audio with a silent door, shot by shot (vivijure-core#442).**

`per_shot_motion` and `motion_configs` were arguments of `startFilmFromKeyframes` only, and pre-clip dialogue was decided from the film's default door alone. A driven default door lost the map after pre-clip dialogue, so every clip went to the default door; a silent default door with a driven mapped shot never bought that shot's audio. `FilmJob` now keeps `per_shot_motion` and `motion_configs`, and every audio decision is made from each shot's own door:

- Pre-clip dialogue runs when any shot's door has `usage.driving_audio`. Every line is bought there, once, so a lined shot on a silent door still has its line for lip-sync and the post-clip leg does not buy it again.
- `advanceToClips` starts each clip on its own door with its door's config (`module_configs`), as the first clip start already did.
- Only a shot on a driven door gets `audio_url`, has its `seconds` follow its line, and has its line padded or trimmed. An unlined shot on a driven door gets minted silence (or the native-audio neighborhood mark); an unlined shot on any other door gets nothing.
- The duration gate reads a line's length only for a shot on a driven door; a silent-door shot is gated against its board.

A film whose shots all use one door behaves exactly as before.
