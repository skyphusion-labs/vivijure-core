**Fix: a cut to different people is a hard cut on a first_last door (vivijure-cf#1140).**

The next shot's start still was sent as the end frame on every shot, so the clip morphed into the next shot and the first character left the screen before the cut. The end frame is now sent only when both shots hold the same `character_slots`. A shot that does not state its slots keeps the old behavior.
