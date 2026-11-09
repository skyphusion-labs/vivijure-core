### Fix: a 4xx from the URL beat door fails on the first read instead of burning the attempt cap (vivijure-core#358)

`analyzeViaUrl` classed every non-2xx from the beat door as transient. That is the safe direction for a paid film, but a 400 or a 404 is the container answering and refusing, so three attempts gave the same verdict three times. New `beatDoorStatusTransient(status)`: a 4xx is permanent except 408 and 429, which mean "come back". A 404 on this door means the container has no `/analyze` route, which is a deploy or config mismatch. Every other status, 5xx included, stays transient, unchanged. No 4xx has been observed from this door; this records the cost before one shows up.

**For a host.** A film whose beat door answers 4xx (not 408 or 429) now fails on the first beat read with the same `beats were not read: beat-sync container returned HTTP <status>` error, instead of on the third.
