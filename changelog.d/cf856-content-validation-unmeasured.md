### fix(content-validate): a Layer 2 skip is recorded as UNMEASURED instead of vanishing

Measured on a live film while the video-finish container was crash-looping (cf#851):
five `clip.content_validate` events, every one `verdict: "skip"`, zero passes, and
the film advanced from clips to assemble anyway. The #523 Layer 2 pixel gate did not
look at a single clip and nothing in the render record said so. It was visible only
because someone had `wrangler tail` attached at the time.

It is deceptive rather than merely quiet: Layer 1 (structural) PASSES on the same
clips, because it needs no container. A reader sees `validate: pass` beside
`content_validate: skip`, one word apart, and only one of them inspected anything.
Today the consequence is hidden because assemble fails afterwards; the day assemble
works, a film ships with content validation never having run.

**The fix is not to fail on a skip.** A momentary `/inspect` blip must not kill a
fully rendered film, and #30 already established that a skip must not even be
persisted as a VERDICT, because a truthy `content_validated` short-circuits
re-inspection and one blip disables the gate for the whole pass. The defect is that
the skip is SILENT and indistinguishable from a pass.

So the two facts are now separate fields. `content_validated` still stays unset on a
skip, exactly as #30 requires, and a new `content_unmeasured` carries the honest
reason, written only when it CHANGES (so a down inspector does not rewrite the doc
every tick) and cleared the moment a terminal verdict lands (so it cannot go stale).

The film doc then carries `content_validation { checked, unmeasured, reasons }`,
recomputed from the clip doc on every finish pass, and `filmDonePayload` projects it.
It lives on the FILM doc rather than being derived from the clip doc at projection
time for a specific reason: `filmDonePayload` has two writers and only one holds the
clip doc (core#205), so a clip-derived key is absent from the finalize write, and a
field whose whole purpose is to say "this did not run" cannot be the field that goes
missing.

Same three-state ladder as cf#836, because it is the same failure: absent means Layer
2 never ran (a self-host with no `VIDEO_FINISH_URL` is exactly this, and honest),
`unmeasured: 0` means it ran on every clip, and `unmeasured: n` means it could not
measure n of them.

Refs vivijure-cf#856, vivijure-cf#851, core#30, core#205, vivijure-cf#836.
