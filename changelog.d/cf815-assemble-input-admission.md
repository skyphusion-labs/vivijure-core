### feat(assemble): refuse a film that cannot fit the container's disk, before the first presign

A chunked assemble had no bound on the film it produced. cf#784 flattened peak disk for the BATCH
stage (each batch dir is reaped on flush, each partial goes straight to R2) but left FINALIZE
untouched, and finalize holds **two** full-length copies at once: `_silent.mp4` from the join, then
`final.mp4` from `_mux_bed_onto`, with no remove between them and no re-encode on the no-bed branch.
Nothing bounded either. The container's own comment says "peak disk at that stage is one film"; the
code says two.

`enterAssemblePhase` now predicts the film's normalized bytes and refuses before a single presigned
URL is minted, so an over-size job costs zero downloads, zero CPU and zero container time.

**The threshold is deliberately NOT `MAX_CLIPS x MAX_CLIP_BYTES`.** cf#813 measures that product
(80 x 256 MB = 20.0 GB, the whole disk) as 23x to 120x above what a real film weighs, because
`MAX_CLIP_BYTES` is the size at which a DOWNLOAD is refused rather than a payload. A gate written
against it could never fire, which is worse than no gate because it reads as protection. It is also
the wrong quantity: cf#813 measures the normalized-to-source byte ratio at 0.98x to 5.09x, so
source bytes do not predict the film either.

It is written instead against cf#813's measured encodes through this container's exact normalize
command: 0.225 normalized bits per pixel per frame, derived from the 1080p24 crf18 ceiling of
11.16 Mbps and cross-checked against that measurement's independent 720p row (predicts 4.98 Mbps
against a measured 4.82). The ceiling of the band, on purpose, so the refusal is early rather than
late.

**What this catches that nothing else could.** The unbounded dimension is DURATION, not clip count.
A 62s clip at a plausible bitrate is ~60 MB, a quarter of `MAX_CLIP_BYTES`, so 80 of them sail past
every existing guard and then ask the container to hold ~13 GB of film on a 20 GB disk. The gate
fires at roughly 82 minutes of 1080p24 delivery and admits everything below it, so the largest
legitimate film the clip path can produce (80 clips x 8.0s, about 0.9 GB predicted) keeps a 7x
margin.

Length comes from EVIDENCE: `measuredClipSeconds` reads `delivered_frames / delivered_fps` off the
clip doc the render already wrote, the plan fills any shot the probe missed, and a shot with neither
contributes zero and is COUNTED, so a partial basis is reported as the lower bound it is. An
all-unknown film is admitted rather than refused, mirroring the #697 duration gate: the check fires
on evidence, never on absence.

Refusal is terminal and loud, never a degrade (the #249/#77 discipline): the error carries what was
asked, what fits, by how much it is over, the measured/planned/unknown split, and the length that
WOULD be accepted, and a test asserts that length is actually admissible.

Both failure modes are held red by construction. Neutering the gate to always-admit fails 11 of the
28 new tests including every seam assertion; setting it to always-refuse fails 8, including the
control that a legitimate large film still assembles. The seam tests assert on presign COUNT, which
is the thing the container's cost actually turns on: a refusal that still minted 80 GETs, a PUT and
an 80-pair partial pool would have saved nothing.

Refs cf#815, cf#813, cf#784, cf#801, cf#808, cf#793, #301
