### fix(assemble): an unreachable finish tier delivers the clips instead of failing the render

`videoFinishReachable` answers "configured or bound", never "serving", so the #519
clips degrade was only reachable when `VIDEO_FINISH_URL` was UNSET. With the door
bound and DEAD the guard was false, the degrade was skipped, and the film hard-failed
at assemble, after the keyframe and i2v spend, delivering nothing.

That is not hypothetical: cf#851 is a container that crash-looped on a missing import
and died before binding 8000. The binding resolved, the predicate said reachable, and
tonight's films failed in exactly this shape.

**The submit is the honest observation, so no probe was added.** A probe answers "was
it up a moment ago"; the submit answers "is it up now, for this request", and it costs
nothing extra because the call already happens. `submitAsync` now reports WHY it
failed instead of returning a bare null:

- **unreachable** (the transport threw, no response, or a 502/503/504 from the EDGE):
  the tier could not be reached at all, so the film takes the #519 clips degrade and
  declares it through `finish_unavailable delivered: "clips"`.
- **refused** (the app answered with a non-202, a 202 with no jobId, or an unreadable
  body): the container RAN and said no. That still fails the render loud, as do an
  expired job and an auth error. `degradeAssembleUnavailable` has always documented
  itself as the unavailability path only (#245/#249), and this keeps it that way.

The caller reads a typed `unreachable` field, never the error prose.

**This NARROWS cf#746(a) rather than reversing it.** Its three mux cases are untouched
and stay green. What is retired is the parity assertion that both legs must reach the
same PHASE, because cf#746(a)'s own rationale is mux-specific: "the silent film is
still in R2, so failing loses nothing a degrade would have kept" is true at mux and
false at assemble, where failing loses the clips. Measured rather than assumed:
`FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS` is 60, a double-click guard and not a resume,
so a resubmit is a new `film_id`, new clip keys and re-paid GPU. Both outcomes are
terminal; the degrade additionally hands over clips already paid for.

The offence in the original defect was never partial delivery, it was mislabelling: a
silent film presented as complete is a lie about content, while per-shot clips declared
as a clips delivery are a partial deliverable labelled partial. cf#836 put those keys on
the payload and cf#833 exempted the clips shape from the deliverable gate, so as of
this cycle the declaration is visible to a user rather than only in a log line.

Refs core#327, vivijure-cf#746, vivijure-cf#851, core#519, vivijure-cf#836, vivijure-cf#833.
