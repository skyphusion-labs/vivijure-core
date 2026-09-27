### fix(film): judge the assembled film, do not merely count it

The film was accepted on R2 PRESENCE alone: both decision points read
`head(key) !== null` and discarded the size, so a 0-byte `film.mp4` satisfied the
#122 shortcut and shipped as `done`. Clips have had a real structural gate since
#523 (a byte floor, duration bounds, an `ftyp`/`moov` parse); the film, the thing
the user actually receives, had none.

`clip-validate.ts` now exposes ONE probe with TWO judges. The parser is shared;
the bounds are not, and that distinction is the point: `CLIP_MAX_DURATION_S` is
900s, so reusing `judgeClip` wholesale would have REFUSED any film longer than
fifteen minutes as a runaway. `judgeFilm` keeps the byte floor, the container
parse, the video-track and frame checks, and drops the upper duration bound.

The done transition validates the key it is about to stamp on the renders row,
including a key recovered by the #99 adoption probe, since adoption proves
presence and presence is what this issue is about not accepting. A film that is
present but whose bytes could not be read this tick is a SKIP, not a failure: that
is an R2 condition, not a verdict on the artifact, and it is logged.

Separately, `pollVideoFinishAsync` synthesized `{ ok: true }` when the container
reported `completed` with no result object. That is the studio inventing a success
the container never claimed, and everything downstream read the resulting
undefineds as absent-but-fine: `clipDurations` undefined no-ops the #697 duration
gate, and `hasAudio` undefined is not `=== false`, so the mux degrade branch is
skipped and `film_key` advances to an output key that may never have been written.
A completion carrying nothing is now a failure.

The #697 duration gate itself is unchanged. Its skip-on-no-durations is correct
under "fire only on evidence"; what was wrong was that a caller could reach it
with a result that had no durations in it on demand, and that is what the
synthesis fix closes.

Refs vivijure-cf#835.
