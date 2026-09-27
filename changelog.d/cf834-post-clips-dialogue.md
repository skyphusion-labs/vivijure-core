### fix(dialogue): the post-clips leg fails what it cannot deliver, and declares what it degrades

The POST-CLIPS dialogue leg answered all six of its failure branches with a
`console.warn` and a silent finish, while the PRE-CLIP leg answers the identical
six with `incompleteFilmError`. Which leg a film takes is decided by its motion
door declaring `driving_audio`, and only `infinitetalk` and `alibaba-wan` do: 13
of the 15 installed doors, `seedance` (the hosted speed default) among them, took
the unguarded one. A film that asked for voices shipped mute and the record said
it shipped.

Two of those six branches did not even warn, and there was a seventh route on the
SUCCESS path: `audio: []` is a conformance-valid dialogue output, so a module that
returned nothing took the green path and `applyDialogueOutput` folded nothing. The
completeness check `finalizePreClipDialogue` has always run (a set difference of
the lined shots against `dialogue_audio`) is the only thing that can see it, and
this leg never ran it.

The rule applied is the one the mux leg adopted in 1.23.0: DEGRADE WHEN A RETRY
CANNOT HELP, FAIL WHEN IT CAN. Five branches fail (submit failure, contract
violation, poll failure, module unbound mid-flight, an incomplete or empty set).
The sixth, no dialogue module INSTALLED, is a real degrade (the same shape as the
#519 video-finish tier being absent): the film ships silent, and now says so
through a new `job.dialogue_degraded` and a `dialogue.unavailable` structured
event, instead of leaving nothing behind at all.

`dialogue_degraded` is deliberately NOT folded into `finish_unavailable`, whose
contract is the video-finish tier being unavailable at assemble or mux; widening
its two closed unions to carry another stage would turn the field into "something,
somewhere, was missing". Projecting it to the payload is cf#836.

Also, nothing in the suite drove this leg: the only file binding a dialogue module
sets `driving_audio: true` in both of its fixtures, so every case there took the
pre-clip branch. There was no reachable world in which this leg's guard went red,
because there was neither a guard nor a test. Both now exist.

Refs vivijure-cf#834.
