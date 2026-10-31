**Fix: a refused mix keeps the voices, not the bed (vivijure-cf#1158).**

When the mix could not be made, the bare bed replaced the film's audio, so a film with spoken lines shipped with music and captions and no voices. It now keeps the voices, and `finish_incomplete` names the bed as lost.
