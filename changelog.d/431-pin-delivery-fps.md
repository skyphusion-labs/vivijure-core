### Feat: a film start pins the frame rate, as it pins the frame (vivijure-core#431)

`startFilmJob` took `delivery_width` / `delivery_height` (#430) and not the rate, so a long film's parts could still differ at the join: a part with interpolation ships at 48 fps and one without at 24, and the join refuses parts that differ.

- `startFilmJob` takes `delivery_fps` and persists it on the job, as `startFilmFromKeyframes` already did. It wins over the rate the finish chain produced (`resolveDeliveryFps`), and a clip above it already carries the note `finished clip is N fps, delivered at M fps`, as a clip larger than the frame does.
- **Fix-forward:** neither submit fingerprint held the delivery pin, so two submits that differed only in frame or rate were deduplicated into one film. Both natural keys now include `delivery_width`, `delivery_height` and `delivery_fps` when set. A submit that pins nothing gains no field, so its key is unchanged and a submit in flight across the upgrade still deduplicates.

**For a host.** Pass one `delivery_fps` to every part of a long film, beside the frame (vivijure-cf#1389). Absent, the rate comes from the finish chain as before.
