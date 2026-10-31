**Fix: a host with no audio-mix door keeps the voices too (vivijure-cf#1158).**

With `AUDIO_MIX_URL` unset, a film with spoken lines got the bare bed in place of its voices. It now keeps the voices, and `finish_incomplete` names the bed as lost. A film with no lines still gets its bed.
