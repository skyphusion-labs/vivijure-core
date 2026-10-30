**Fix: `clip_deliveries` reports the frames a clip has, not the frames it planned (vivijure-cf#1125).**

Many doors report `seconds * fps`, so a 141 frame clip read 144 and planned and delivered agreed by construction. Clip validation already reads the file, so its frame count now replaces the report, and the door's rate is kept while the file agrees with it. A delivery read from the file carries `measured: true`. Without it, the numbers are the door's report. `measuredClipSeconds` and the assemble budget read these values, so they move slightly.
