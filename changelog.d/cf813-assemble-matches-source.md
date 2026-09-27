### fix(assemble): the delivery target matches the measured source instead of a constant (cf#813)

The assemble seam called `resolveDeliveryResolution(job)` and nothing else. That function reads
`delivery_width` / `delivery_height` and nothing about the clips, and **nothing in either repo ever
sets those fields on a job**, so the target was 1920x1080 on every film in production, applied with
no source-equals-target short circuit. Most installed motion doors default BELOW that, so the normal
case was an upscale carrying no information and costing bytes and CPU; a door configured above it
was destructively downscaled.

The source dimensions were already measured on every done clip, already persisted, and already read
back by `measuredClipDimensions` one function away. They were simply never read at this seam.
`resolveAssembleDelivery` now does, in a fixed precedence:

1. an explicit `delivery_*` on the job **wins**, because a measurement must never silently override
   an operator decision;
2. otherwise the measured source geometry;
3. otherwise the historical default, reported as `default-unmeasured` rather than as a fact.

`DeliveryResolution` gains a required `basis` (`operator-override` / `measured-source` /
`measured-source-mixed` / `default-unmeasured`). Required rather than optional so tsc enumerates
every construction site, for the same reason `decided` exists: `decided` answers "did somebody
choose this", `basis` answers "choose it from WHAT". The admission gate added in core#307 sizes a
byte budget against this target, and a budget built on a default is a different claim from one built
on a measurement.

**The mixed-resolution rule is now a choice rather than an accident.** A `-c copy` concat needs one
geometry, so "never upscale AND never downscale" is satisfiable only when the clips agree. A mixed
film takes the largest-AREA geometry **that a real clip actually has**:

- largest, because a downscale destroys information irreversibly while an upscale only wastes bytes,
  so when the two cannot both be honoured the non-destructive one wins and no clip is degraded;
- a real pair rather than componentwise max, because `max(width)` and `max(height)` taken
  independently can invent a geometry no clip has. A film mixing 1920x1080 and 1080x1920 would yield
  1920x1920, an aspect ratio nothing rendered, pillarboxing AND letterboxing every clip. Choosing an
  actual pair guarantees at least one clip passes through untouched.

Ties resolve to the wider geometry, deterministically, so input order cannot change the film.

**Aspect ratio falls out of the same rule.** `pad=` used to pillarbox a 9:16 clip into a landscape
frame; a vertical film now targets a vertical frame and there is nothing to pillarbox.

No container change is required: `video-finish` already scales to the width and height it is handed.

14 cases in `tests/assemble-delivery-matches-source-cf813.test.ts`, both directions pinned (a
720p-source film delivers 720p, a 4k-source film is not downscaled) because a rule proven in one
direction is half a rule. Watched red twice: reverting the seam to ignore measurements fails 3 cases
and leaves the 11 pure-selector cases green, and swapping the mixed rule for componentwise max fails
exactly the trap case (`expected 3686400 to be 2073600`).
