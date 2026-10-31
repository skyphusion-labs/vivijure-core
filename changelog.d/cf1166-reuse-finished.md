**Fix: a retry can keep what it already paid for (vivijure-cf#1166).**

`startFilmJob` and `startFilmFromKeyframes` take `reuse_finished`. With it set, a clip, a spoken line or a finish step whose inputs are proven identical is kept, and no door is invoked. It is off by default, because a plain resubmit asks for a new take. Clip provenance now also covers the end frame, the driving audio and the voice sample.
