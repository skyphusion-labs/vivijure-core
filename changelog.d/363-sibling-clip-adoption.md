### fix(clips): a render no longer adopts a sibling door's clip

Two doors on one project could ship byte-identical films, both marked done. The reclaim matched an
archived take as a motion clip, and it adopted a lone unstamped clip that was a live sibling's. A take
is now never a candidate. A lone unstamped clip is adopted only after it has settled for five minutes.
A clip with a matching sidecar is still adopted at once.
