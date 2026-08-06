# Changelog

Notable changes per `@skyphusion-labs/vivijure-core` release. Tag + npm publish details live in
[`RELEASES.md`](RELEASES.md). Entries are newest-first.

## [Unreleased]

### Chore: drop dead `sync:module-types` script (cf#315)

The script copied from `../vivijure/src/modules/types.ts`, a path that no longer exists (hub is docs
only). `src/modules/types.ts` is the in-tree canonical source; the script only failed and misled
editors into treating the file as a copy that could be clobbered.
### Fixed: untrained `cast_loras` refusal names the voice-only path (mcp#29)

`untrainedCastMessage` still tells the operator to train on the Cast page, and now also names
`dialogue_lines[].voice_id` as the path for voice without an identity adapter. Agents that followed
"pass cast_loras for voice" hit a hard 400 and were pointed at an expensive train they did not need.
## Unreleased

### feat(cast): per-family adapter readiness on public cast rows (vivijure-cf#383)

`lora_status: "ready"` is shared across SDXL and Wan adapter families, so a Wan-trained cast with
`lora_key` null still read ready and could be bound for keyframes with no identity LoRA (silent wrong
output). Public cast rows now carry additive booleans derived from key presence:

- `sdxl_lora_ready` -- `lora_key` under `loras/`
- `wan_lora_ready` -- both `wan_lora_key_high` and `wan_lora_key_low` under `loras/`

Legacy `lora_status` is unchanged (shared last training-job state). Prefer the new fields for
selection / preflight. Helpers: `isSdxlLoraReady`, `isWanLoraReady`.
### Added: `FilmSummary.assemble_ms` + `output_ms` (vivijure-cf#365)

Additive poll-surface fields. `film_output_seconds` already stored per-artifact content length
(assemble writes the deterministic `renders/<id>/film.mp4` entry; film.finish writes each step key;
markFinishDone bills the final film_key as `renders.output_ms`). None of that reached `summarizeFilm`
/ poll_film, so a delivered-vs-predicted delta could not be decomposed without D1 or R2.

- `assemble_ms` -- pre-film.finish concat content length (ms) at the deterministic assemble key
- `output_ms` -- last-writer DELIVERED content length (ms) for `job.film_key` (same basis as the D1 column)

Absent = NOT MEASURED (never coalesced to zero). Distinct from `finish_elapsed_ms` (CPU wall-clock,
cf#268). No new capture path; pure projection of an already-persisted map.
### Fixed: operator install-config patch can report discarded keys (vivijure-cf#387)

`clampInstallPatch` still drops unknown / render-scope keys (invoke path stays forgiving). New pure
helpers for host routes that must refuse a silent no-op:

- `droppedInstallKeys(schema, patch)` -- keys present in the patch that are not install-scope
- `clampInstallPatchDetailed(schema, current, patch)` -- `{ next, dropped }`

Hosts (cf PATCH `/api/modules/:name/config`) should 400 when `dropped` is non-empty. No
`setInstallConfig` return-shape change; gate before write.

## v1.7.3

PATCH: dependency updates and docs (CLAUDE release procedure) on main since 1.7.2. Publish via tag `vivijure-core-v1.7.3` (not bare `v*`). Hosts (cf/local) should pin after this lands.

## [1.7.2] -- 2026-08-03

### Fixed: `film.finish` lost the delivered length and prepend on the ADOPTED completion path (#131, #132; core#130, #663; vivijure-cf#268)

PATCH. Behaviour fix on an existing capture path; no module contract bump. `readStepMeta` and
`metaKeyFor` are new exported functions in `src/film-orchestrator.ts`, and because `src/index.ts`
re-exports that module with `export *`, they are technically reachable through this package's public
surface -- but neither is a deliberate new API for module authors to call. They exist to serve
`runFilmFinish` internally, no consumer needs to import them directly, and that is why this ships as
a PATCH rather than a MINOR.

`runFilmFinish` walks each `film.finish` step and checks R2 for the step's deterministic artifact
BEFORE it checks the poll token. When the container PUTs between polls, the next tick ADOPTS: it
advances `curKey`, discards the token, and continues. The step's output is therefore never read, and
the two numbers that travel only on that output -- the delivered length and any title-card prepend --
were lost. Both writers of those maps (`foldOutput` and the legacy synchronous branch) require a
module output body, so an adopted step recorded no measurement at all.

**Why it survived review.** Adoption is the NORMAL completion route on the async drive path, not an
edge case -- R2 presence reliably beats an 8-second client-driven poll. #124 filed this as the rare
residual; it fired on the first real render instead, as a NULL `output_ms` on a COMPLETED, billed
film. The error runs in the flattering direction -- a NULL on a COMPLETED row bills nothing, silently
-- so nothing failed loudly enough to be caught by a suite that only exercised the non-adopted path.

**The fix** is a measurement sidecar written next to the artifact at `<outKey minus .mp4>.meta.json`
(`metaKeyFor`), presigned in `filmFinishSeed` alongside the `.srt` sidecar that already exists for
the same reason (#663). The adoption branch reads it back (`readStepMeta`) and feeds the existing
`recordDuration` / `recordPrepend`, so there is no new persistence and no orchestrator state-machine
change. The same handler writes both the artifact and the sidecar, so the two states cannot diverge
by construction. Absent, unreadable, or malformed lands on `undefined` -> NULL, identical to the
pre-change behaviour: this recovers a measurement that was actually written, it does not license
inventing one. A value folded from a live module output always wins over the sidecar copy.

`readStepMeta` gates on finite AND positive, the same gate as the fold path: a 0, a NaN, or a
negative is not a measurement of a film. A companion doc-only change explains why this deliberately
diverges from the control plane's RunPod-meter gate (`Number.isFinite` alone, so a genuine
`executionTime: 0` survives there) -- 0ms of execution is a real measurement, a 0-second video is
not, and the two gates measure different quantities.

Contract change is additive and optional (`meta_url` / `meta_key` on `FilmFinishInput`), the same
shape and reasoning as `prepend_seconds`: no module-contract epoch bump, and an older module against
a newer core (or the reverse) behaves exactly as it does today. **Reading half only.** The
video-finish container's write half is merged (vivijure-cf#370, `_put_meta_sidecar`) and built
(image `d26db499`, 2026-08-02T23:47Z), but not yet running in production: the swarm stack
(`vivijure-media.stack.yml`) still pins the prior digest (`0434011`), which predates the sidecar,
pending a repin. Until that repin lands, every film keeps adopting to NULL exactly as before, so
this is safe to release alone and in either order.

**Left open here:** core#119, the missing changelog/version guard that let these two
commits sit on `main` past the published 1.7.1 with no `[Unreleased]` section to catch it -- this
patch exists as a standalone prep PR rather than having shipped inside a guarded window. Left open,
tracked separately.

## [1.7.1] -- 2026-08-02

### Fixed: `renders.output_ms` was WRITE-ONLY -- nothing could read it back (vivijure-cf#268)

PATCH. Completes 1.7.0 rather than adding to it; no behaviour changes for module authors.

1.7.0 shipped the capture -- `markFinishDone` writes `renders.output_ms`, the metering basis -- and
added the column to **no read path at all**: not the shared `RENDER_ROW_COLUMNS` list, not
`RawRenderRow`, not `normalizeRow`. So the value was written and then invisible. Not to the panel,
not to the meter that will eventually bill on it, and not to the smoke meant to prove it landed. The
only way to observe it was an account-credentialled D1 query.

Added at all the hops it was missing. `PublicRenderRow` needed no change: it is
`Omit<RenderRow, ...>` and `toPublicRenderRow` spreads, so the field reaches clients by
construction once it is on `RenderRow`.

**Why it survived review and a full test suite.** Every 1.7.0 test asserted the WRITE, through a
stubbed D1 binding, by inspecting the UPDATE's bind parameters. **A capture path with no reader
passes every test that only exercises capture** -- the stub was the boundary, so the read side was
not merely untested, it was out of frame. The new suite drives the REAL read functions and asserts
the SQL, and it fails on 1.7.0 in all six cases, which is the only reason to trust it.

The four-hop shape is the hazard worth naming: `RENDER_ROW_COLUMNS` -> `RawRenderRow` ->
`normalizeRow` -> `RenderRow` -> `toPublicRenderRow`. The column list is a **template string the
compiler cannot check against the row interface**, so a field dropped at that hop vanishes with no
type error. That is exactly how it went missing.

NULL semantics are preserved and asserted: NULL means NOT MEASURED and is never coalesced to 0 -- a
zero is a film of no length, and a billing query that cannot tell them apart bills nothing for a
real render. A legacy row predating migration `0016` reads `null` rather than `NaN`.

## [1.7.0] -- 2026-08-02

### Added: the DELIVERED film length, captured and written to `renders.output_ms` (vivijure-cf#268, skyphusion-labs/vivijure#805)

MINOR (additive). Requires the host to have applied `vivijure-cf` migration `0016`
(`renders.output_ms`); a host without that column will error on finalize, so bump the dep only
after migrating.

**BEHAVIOUR CHANGE FOR MODULE AUTHORS, and it is the one thing to read here.** The `film.finish`
conformance check now REJECTS `duration_seconds` when it is present and `<= 0`. A module that
returns `duration_seconds: 0` was previously accepted and is now a conformance failure, which the
core treats as a soft-degrade of that step. This is deliberate: the value feeds a BILLING column,
and a stored 0 is indistinguishable from "not measured" at exactly the point the deduction reads
it. If your module cannot measure its output, OMIT the field -- absent means unknown and is stored
as NULL. It is not a hypothetical: `subtitle` returns the container's `durationSeconds`
unconditionally, and a sidecar-only run leaves it at a `0.0` initialiser, so forwarding it blindly
would have degraded a working path. That is what this rejection caught (vivijure-cf#359).

WHY. Conrad's ruled metering basis is a deduction on the final length of a successfully completed
video -- "we bill on the last writer" (2026-08-02). Nothing captured that number. The core read the
video-finish container's ffprobe `durationSeconds` at assemble, used it for the partial-film guard,
and discarded it; `duration_seconds` in plan JSON is the REQUESTED duration, which is a different
quantity (every non-final tier delivers clips shorter than their planned target).

**Last writer is structural, not an ordering rule.** `FilmJob.film_output_seconds` /
`ScatterJob.film_output_seconds` map FILM ARTIFACT KEY -> measured seconds, and every stage that
writes a film records into it (assemble, mux, each `film.finish` step). The delivered length is then
a LOOKUP OF THE FINAL FILM KEY, so a noop/passthrough final step correctly reports the artifact it
passed through, and nobody has to iterate in the right order for the answer to be right. Three
container routes each emit a `durationSeconds`; billing the assemble one under-bills by the length
of every title card, on every film that gets one.

**Persisted, because the chain ADOPTS.** A `film.finish` step whose artifact is already in R2 is
adopted (#600 survivability) and the adoption branch makes NO container call, so nothing folds and
no duration arrives that tick. A length read only from a live dispatch result is lost on precisely
the films long enough to span ticks -- the expensive ones -- and lost as a NULL on a COMPLETED row,
which bills nothing. Same mechanism and same reason as `film_finish_prepend`.

`markFinishDone` gains an optional trailing `outputMs`. `output_ms = COALESCE(?, output_ms)` is
LAST-WRITER-WINS, not a first-writer guard: a supplied value ALWAYS overwrites, and only an absent
one leaves an existing measurement alone, so passing null means "I did not measure it" and never
"erase it". `outputMsFromSeconds` is exported and converts at the DB boundary only -- seconds on the
module contract (the container's unit), integer milliseconds in the column, because a float has no
business in a billing input.

`FilmFinishOutput.duration_seconds?: number` is additive and optional, mirroring `prepend_seconds`
exactly; no `MODULE_API` bump, and a module that omits it is unchanged.

**NOT COVERED, deliberately:** a step adopted having NEVER been folded (the container PUT the
artifact between polls, so its output never reached the core) yields no length and the row carries
NULL. That is the honest answer rather than a fabricated one, and it is the same coverage
`prepend_seconds` has. NULL means NOT MEASURED and must never be coalesced to 0.

**Epoch note for whoever does the `vivijure-cf` dep bump.** Until this release is on the registry
and cf bumps to it, cf installs 1.6.0, which has no `<= 0` rejection. The companion assertion in
`vivijure-cf` `tests/film-finish-duration-805.test.ts` ("a sidecar-only run still passes
conformance") therefore proves WELL-FORMEDNESS, not rejection, in that window -- it was verified to
stay green under a blind-forward reconstruction for exactly this reason. The assertion that holds
regardless of core version is the one above it (no `duration_seconds` key at all). After the bump,
both mean what they say.

Ships vivijure-core#124. Consumers: vivijure-cf#357 (the migration) and vivijure-cf#359 (the
modules that report the length).

## [1.6.0] -- 2026-08-02

### Added: `dialogue_lines` on `startFilmFromKeyframes` (vivijure-cf#334)

MINOR (additive; one optional parameter). **No existing caller changes behaviour**: a caller that
does not pass the field builds a byte-identical job doc to 1.5.0, because the field is persisted
only when the resolved batch is non-empty.

WHY. `startFilmFromKeyframes` had no `dialogue_lines` parameter and never set the field on the job
it builds. Its callers are the finalize family: render-from-keyframes, finalize, animate-cloud and
animate-hybrid, on both hosts. So that entire family was **structurally incapable of a voiced film**
regardless of what its door resolved, and no amount of work in a host could fix it.

This is not a latent field nobody reads. `enterFinishPhase` derives its dialogue-aware finish order
from `job.dialogue_lines` (the #584 rule that puts an audio-consuming lip-sync module FIRST on a
shot that has a line) and then calls `enterDialogueOrFinish`, which is what submits the speech
batch. A from-keyframes job enters at phase `clips` with a `clip_job_id`, and the clips-phase
advance is `derive_mode` agnostic, so both are reached on every one of these renders. The field was
read on this path and never written.

The lines are joined onto the coerced scene ids with the same `coerceDialogueLineIds` that
`startFilmJob` uses (#563). Without that a caller supplying its own id scheme (`s1`/`s2`) strands
the TTS audio under keys no consumer reads, and the film ships silent and uncaptioned even though
the speech synthesis ran and was paid for.

### Fixed: the scatter dialogue comment claimed the bundle is lossy (vivijure-core#122)

Comment-only. `startScatterRender` reads dialogue from D1 `last_storyboard` and justified it with
"the bundle can't carry this (lossy)". That has been untrue since #307 taught the storyboard.yaml
serializer to emit the per-shot dialogue block and #313 taught the parser to read it back; measured
against production, 16 of 62 bundles carry one today, and running this package's own
`parseStoryboardScenes` over a real bundle recovers both lines with slot and text intact.

D1 being FRESHER than a snapshot bundle is a real and sufficient reason to prefer it, so the
behaviour is unchanged and correct. The stale wording is worth correcting rather than deleting
because acting on it means "repairing" a bundle format that is not broken. The comment now also
names the cost the D1-only rule carries: with no `project_id` there is no fallback, so a
bundle-only scatter renders silent while holding a bundle that carries every line it needed. Adding
that fallback changes an existing caller's behaviour and is tracked separately on core#122.

## [1.5.0] -- 2026-08-01

### Added: the per-job tenant R2 credential on the invoke envelope (cp#270)

MINOR (additive; one optional envelope field, one optional manifest field, one new module, four
optional Env declarations). **No existing module changes behaviour**: a module that does not
declare `needs_tenant_r2` receives a byte-identical envelope to the one it receives today.

WHY. Pooling the hosted shared tier (cp#270) means one RunPod endpoint serves many tenants, so
the tenant's R2 destination can no longer live in the endpoint's template environment. It has to
arrive per job, and the worker that submits is a tenant MODULE worker which holds no R2
credential of its own.

THE TRADE, stated rather than presented as free. Two ways to get a credential to the submitter:

- **STANDING residency** -- bind it onto every tenant module script. Each copy then joins the list
  of consumers that must be updated on every credential roll, with a silent staleness failure
  mode. That bug has already happened: vivijure-cf#83, where adopted RunPod templates kept a
  revoked credential after a re-mint and the tenant's first render died 401 on R2.
- **BOUNDED residency** -- the studio, which already holds the credential, passes it on the one
  hop to the module, which uses it and drops it.

This is the bounded option. The credential now exists in a worker-to-worker request body for the
duration of one call, and that is acceptable on a MEASURED basis rather than an assumed one:
Cloudflare's `workers_trace_events` dataset carries no request-body field, and `Logs` is defined
as console messages. The platform does not capture the body; the only way this leaks is if our
own code writes it to a log.

So the guard ships with the field, not after it:

- `withTenantR2` attaches the block ONLY for a module whose manifest declares `needs_tenant_r2`,
  and OMITS the key entirely when there is nothing to attach. The backend REFUSES an explicit
  `"r2": null` rather than reading it as absent, so a producer that emits null fails every job.
- `takeTenantR2` reads and REMOVES the block in one call, the mirror of the backend's
  `strip_from_payload`, so nothing downstream holds an object that still contains the credential.

`InvokeContext` still says "never secrets" and that stays LITERALLY true: `r2` is a SIBLING of
`context`, deliberately, so the existing invariant did not have to be quietly falsified to make
room. The envelope as a whole is no longer secret-free and `InvokeRequest` now says so.

STANDING CONDITION: enabling Logpush **Custom Fields** on tenant module workers requires
revisiting this design. Custom Fields is the documented mechanism for capturing more of a request
than the default dataset, and it is the one configuration change that could make this unsafe with
no code changing.

## [1.4.0] -- 2026-07-28

### Added: `R2_STORAGE_QUOTA_MODE` (cp#195)

MINOR (additive; one new mode knob, a ledger-truth marker, and additive fields on the storage-quota
return types). **No existing studio changes behaviour and no migration is implied.**

The LLM bundled-allowance knob was built for this release and PULLED before tagging (ruled by
mackaye): nothing in core measures LLM spend, so a core knob would have advertised a capability that
does not exist and a self-hoster setting it would get nothing without being told. Shipping an inert
knob in the same release as the census that refuses inert knobs would be this repo arguing with
itself. It stays a plane var until core can measure; the parsing work and its controls are parked on
core#107 rather than deleted.

- **`R2_STORAGE_QUOTA_MODE`** -- what the bytes number MEANS. `deny` (the DEFAULT) keeps it a hard
  ceiling: `507` at the ceiling, `503` fail-closed when the check cannot run, exactly core#52.
  `meter` makes it an INCLUDED quota: nothing is refused, the studio surfaces used-vs-included, and
  whoever is billing meters the overage. cp#195 needs the second behaviour, and the rejected
  alternative (hosted sets no ceiling and a control plane meters it) would have made only the plane
  know the included number, so no studio could show "X of your included Y", would have deleted the
  fail-closed property for hosted tenants, and would have unwound the cp#183 per-tenant convergence.
- **`deny` is byte-identical to core#52**, and there is a CONTROL rather than a claim: six inputs
  (mode unset, empty, whitespace, explicit `deny`, unrecognised, non-string) driven through the same
  expectations, pinning the EXACT message strings rather than substrings, because the message is the
  operator-visible behaviour. Neutering the default to `meter` fails 22 of them.
- **An unrecognised mode falls back to `deny` and WARNS.** That is the opposite of the bytes knob,
  where garbage means OFF, and the asymmetry is deliberate: for bytes, garbage means nobody set a
  ceiling, so absent knob means absent behaviour; for the mode, a studio that HAS a ceiling still
  has to pick a posture and there is no "no posture" to fall back to. Guessing `meter` on a typo
  silently converts a hard stop into unmetered spend, the one direction that costs somebody money
  they did not agree to. It warns rather than throwing, because refusing to boot over a mode string
  takes a studio down for a typo whose safe reading is obvious.
- **`complete` / `reason` on both entry points, the METERING GAP contract.** `meter` has no hard
  cap, so there is nothing to fail closed to, which makes the completeness of the reading
  load-bearing: a silently broken meter plus no cap is unbounded spend carried by whoever bills.
  `complete: false` means UNBILLABLE, with `usedBytes: null` and a human-readable reason, and never
  a zero. Same vocabulary as the LLM meter deliberately, so nobody learns two names for one idea.
- **A hole this closes that predates the change:** `{ ok: true, usedBytes: null }` was ALREADY the
  return for a quota that is not configured at all, so a failed read would have been
  indistinguishable from an unconfigured studio, not merely from a real zero, and billed as zero. A
  CONTROL asserts a real zero, a metering gap and an unconfigured quota stay pairwise
  distinguishable. `overageBytes` follows the same rule: a real reading at or under the quota is
  `0`, never `null`.
- **A readable total is not a TRUE total** (found by rollins). `storageUsedBytes()` returns a
  confident integer on a studio whose ledger has never been reconciled, and that integer is a FLOOR:
  accounting starts at 0 on any studio predating it, and both drift directions only warn. In `meter`
  mode that bills an overage computed from a total nobody can stand behind, in the direction that
  flatters us, and nothing downstream can catch it because a low number and a correct number are the
  same shape. `complete` therefore requires the ledger be ESTABLISHED, via the new
  `markStorageLedgerTrue` / `storageLedgerTrueSince` pair (written by every successful reconcile,
  and callable by a host at studio creation). `deny` decisions are untouched: a floor still denies,
  with the same status and message. **Consequence, stated rather than discovered: until a host
  stamps at creation or an operator reconciles, `meter` reports every window unbillable.** That is
  the correct default; billing off a floor is worse than not billing yet.
- **`storageQuotaState(env)`** -- the observer surface behind the usage route and the
  used-vs-included display, with no submit semantics. ONE computation on purpose: a biller computing
  the number its own way means two numbers can disagree about the same tenant and the one that bills
  is the one nobody can see.

## [1.3.0] -- 2026-07-27

### Added: host-neutral storage accounting + `R2_STORAGE_QUOTA_BYTES` (core#52)

MINOR (additive; new module `storage-quota`, one additive optional field on `R2ListedObject`).

- **`R2_STORAGE_QUOTA_BYTES`** -- an operator knob with the same shape as `SPEND_DAILY_CEILING`: unset
  (or `0` / non-integer) = OFF, a positive integer = a byte ceiling enforced at submit with an **honest
  deny** carrying the real numbers (`507`, used vs limit). Fail-CLOSED when the quota is set but its own
  check cannot run (`503`), because a novice self-funds the bill.
- **Usage is accounted at WRITE TIME in the host DB**, never read from an R2/S3 usage API. A CF-specific
  usage read would break the Node/MinIO host, which is a parity break for a parity feature.
  `meteredR2Bucket` / `meteredObjectStore` wrap a host renders store so every put upserts the object key
  at its current size and every delete drops its row. Keying on the object key is what makes rewrite
  honest: a job doc written on every advance tick updates one row instead of inflating a total. Wrapping
  is idempotent, so a per-request seam cannot double count.
- **Accounting never fails a write.** A ledger error warns and drifts the counter low; the gate is at
  submit, and `reconcileStorageUsage` rebuilds the ledger from the object store (Platform ICD `list` +
  `head`) as the repair and as the one-time backfill. Artifact sizes are not derivable from the studio
  DB, so the counter starts at 0 on an existing studio and the operator reconciles; that is stated in the
  docs and surfaced by the panel usage route rather than left as a quietly-wrong number.
- `R2ListedObject.size?` is now carried through the R2-compat `list()` when the host reports it (the
  Workers binding and an S3 `ListObjectsV2` both do), so a reconcile skips a HEAD per object. Absent means
  "not reported", never "empty".
- `meteredR2Bucket` / `meteredObjectStore` are GENERIC in the store type, because the wrapper is a
  pass-through Proxy: a host store that extends the ICD (the Node `ArtifactStore` adds
  `getBytes`/`getRange`) keeps its full type, not just its methods. A compile-time assertion in
  `src/storage-quota.ts` fails the typecheck if either signature stops preserving its input; it lives in
  `src` because `npm run typecheck` does not cover `tests/`, so the same assertion in a test file would
  pass no matter what the signature said.
- Ships parity-gated: this core release plus both panels in the same train. Operator doc:
  [`docs/STORAGE-QUOTA.md`](docs/STORAGE-QUOTA.md).


### Fixed: lip-sync is omitted from the finish chain on a silent shot (core#82)

- A shot with no dialogue no longer lists `finish_consumes_audio` modules in its per-shot finish chain,
  so the planner never invokes finish-lipsync or reaches the RunPod musetalk endpoint for a silent shot.
- `advanceFinishPhase` folds a local no-op when a legacy job still carries lip-sync without
  `dialogue_audio`, so an in-flight job from before this fix cannot strand on it either.
- Recorded here from the tag range: this landed on main between 1.2.14 and 1.3.0 without an entry of its
  own, and an unlogged shipped change is the same ledger hole 1.2.13 had to be backfilled for.

### Added: `host.hooks_unavailable` -- a host can declare hooks it cannot serve (vivijure-cf#98)

MINOR (additive; `MODULE_API` unchanged, `host` is optional and additive by contract).

- `ModulesResponse.host.hooks_unavailable?: Record<string, string>` maps a hook name to an
  operator-honest reason. A key's **absence means available**; an omitted block or an empty object
  means everything the catalog lists is serviceable.
- Closes a broken-button class: a module being **installed** and its hook being **serviceable** are
  different facts, and only the first was ever on the wire. A host without the AI binding still
  advertised a full planning-model picker in which every option 500s, and no frontend work could fix
  it because the payload did not carry the fact.
- Generalizes an existing principle rather than adding one: `catalogForDeploy` already serves the
  empty planning-model list to a demo deploy because advertising capability a deployment lacks is a
  lie. This lets any host say so for any reason.
- Consumers render it **generically** off the hook catalog with the reason printed verbatim, so a
  future unserviceable hook needs no new UI.

## [1.2.14] -- 2026-07-24

- **MINOR, additive: `host.hooks_unavailable?: Record<string,string>` on `ModulesResponse.host`
  (vivijure-cf#98).** Maps a hook name to a tenant-readable reason, and **key absence means
  available**, so a host can state what it cannot serve instead of a panel inferring it. `MODULE_API`
  is unchanged, pinned by test.
- Release window: the vivijure-cf emission plus pin bump and the vivijure-local pin bump ride this
  tag, cf then local, in the same window.
- **fix(deps): patch postcss** to clear the one high npm audit finding (#95).
  (Backfilled 2026-07-28 from the vivijure-core-v1.2.14 GitHub release; the row was missing from this file.)

## [1.2.13] -- 2026-07-24

**Backfilled 2026-07-25.** This version was tagged and published with no changelog heading and no
`RELEASES.md` row; recorded here from the tag range rather than left as a hole in the ledger. Same
class of gap as vivijure-local v1.1.16.

- **Fix (core#92):** the cast-LoRA stuck-training reconciler no longer false-fails a Wan train that
  is observably still running.
- **CI:** adversarial security audit workflow added.

## [1.2.12] -- 2026-07-23

**Fix: reject unsafe GPU `output_key` in `updateRenderFromView` (K3 closeout, core#89).** PATCH.

- Validates `output_key` before persisting render view updates; blocks traversal and out-of-prefix keys.

## [1.2.11] -- 2026-07-23

**Fix: validate audioKey in stageAudioKeyForRenders (KF3 audit).** PATCH.

- Reject unsafe or out-of-prefix keys before any R2 I/O; blocks cross-bucket reads via arbitrary
  `bundles/` or nested `out/` paths while preserving studio `audio/`, `dialogue/`, and `renders/` beds.

## [1.2.10] -- 2026-07-23

**Fix: reject path traversal in tar helpers (KF3 audit, core#86).** PATCH.

- `emitTar` and `readTar` validate every entry name with `isSafeRelKey`; blocks `..` and absolute paths.

## [1.2.9] -- 2026-07-23

**Fix: honor `wanConfigured` in cast train body parse (KF3 audit, core#84).** PATCH.

- `resolveCastTrainFamily` no longer drops Wan routing when the client sends train fields only in
  `renderOverrides`; matches the wired-endpoint default from 1.2.8.

## [1.2.8] -- 2026-07-23

**Feat: default cast `/train-lora` to Wan when the dedicated train endpoint is wired (cf#29 Phase E).** MINOR.

- `handleCastTrainLora` submits to `RUNPOD_WAN_TRAIN_ENDPOINT_ID` by default when configured;
  pass `model_family:"sdxl"` (top-level or in `renderOverrides`) for the legacy render-endpoint path.
- `handleCastTrainWanLora` remains an explicit always-Wan alias.

## [1.2.7] -- 2026-07-22

- **feat: couple local-gpu motion to local keyframes (vivijure-local#153).** When motion locality is
  `local`, a local keyframe module is defaulted or required, so a film render does not quietly fall
  back to RunPod for its keyframes: `coupleLocalGpuKeyframeChoice`, `localKeyframeModule`,
  `localGpuKeyframePreflightError`.
- A whitespace-only backend name is treated as omitted rather than as a name.
- A dedicated `ui.section === "keyframe"` is preferred when picking the global default.
  (Backfilled 2026-07-28 from the vivijure-core-v1.2.7 GitHub release; the row was missing from this file.)

## [1.2.6] -- 2026-07-22

**Fix: adopt-render hijack + TOCTOU race (core#76).** PATCH.

- **fix(security):** harden `handleAdoptRender` so it validates adopted `outputKey` values under
  `renders/<jobId>/`, treats INSERT (`ON CONFLICT DO NOTHING`) as the uniqueness authority so a
  concurrent adopt loser never `markFinishDone`s another's row, and never completes or overwrites an
  existing render row by guessed `jobId` (#76 / #77).

## [1.2.5] -- 2026-07-22

**Fix: film phase `from` on cold isolate + hook catalog display order.** PATCH.

- **fix(film):** `putFilm` recovers prior phase from the R2 job doc when the in-process Map is
  empty (cold CF isolate), so `film.phase` / `film.render.terminal` carry `from: "<prior>"` instead
  of `from: null` (cf#110).
- **feat(modules):** `HookCatalogEntry.order` + `HOOK_DISPLAY_ORDER` so panels sort the pipeline from
  the catalog instead of hardcoding hook name lists (core#54). Additive; no MODULE_API bump.

## [1.2.4] -- 2026-07-22

**Feat: pre-submit RunPod idle workersMax reconcile (cf#61).** PATCH.

- New `runpod-endpoint-reconcile` helpers: detect workersMax below spec via REST GET, PATCH restore
  when the key allows management, honest idle-scale-down guidance when scoped invoke keys return 401.
- `runpod-submit` submitters reconcile before dispatch when `RUNPOD_WORKERS_MAX` is configured.

## [1.2.3] -- 2026-07-21

**Fix: advanceFilmJob wedge fails terminal (#53).** PATCH.

- Non-SyntaxError throws in the advance path (presign, R2 list, clip start) no longer wedge the
  render in IN_PROGRESS forever. Extends the #32 corrupt-doc guard: persist `phase=failed` on the R2
  job doc when readable, mark the D1 render row FAILED with the real reason, and return instead of
  rethrowing. Ships [core#64](https://github.com/skyphusion-labs/vivijure-core/pull/64).

**Fix: COMPLETED film renders record `output_key` when `film.mp4` exists (local#99).** PATCH.

- Single-film completion now mirrors scatter: `transitionToDone` calls `markFinishDone` with a
  resolved deliverable key (`film_key`, `silent_film_key`, or deterministic `renders/<film-id>/film.mp4`).
- `filmJobToPollView` and `updateRenderFromView` backfill `output_key` from store when the envelope
  omitted it (subset-shot / completion-order gap). Ships [core#65](https://github.com/skyphusion-labs/vivijure-core/pull/65).

## [1.2.2] -- 2026-07-21

**Fix: revert #584 as the dialogue finish-order default (cf#29).** PATCH.

- Dialogue shots default back to legacy `ui.order`: RIFE -> lipsync -> upscale (matches June showcase
  quality on CF MuseTalk smokes).
- #584 reorder (lipsync -> RIFE -> upscale) is now **opt-in** via
  `finish_config["finish-order"].dialogue_reorder: true` (or `reorder: true`).
- `finish_config["finish-order"].dialogue_legacy: true` remains an explicit legacy alias (core#61).
- Ships [core#62](https://github.com/skyphusion-labs/vivijure-core/pull/62).

## [1.2.1] -- 2026-07-20

**Fix: Wan LoRA poll harvest writeback (cf#29).** PATCH.

- Poll the Wan train RunPod endpoint so cast LoRA harvest writeback completes (#59).

## [1.2.0] -- 2026-07-20

**Feat: portable Wan i2v LoRA support (Phases B+C, cf#29).** MINOR.

- Wan 2.2 A14B two-expert LoRA helpers + cast columns (Phase B, #56).
- Wan train orchestration + shape-dispatch poller (Phase C, #57, #58).

## [1.1.0] -- 2026-07-18

**Feat: `image.generate` module hook (cf#129 phase 2).** MINOR.

- Additive module contract field for image generation (#55).

## [1.0.0] -- 2026-07-16

**First constellation-stable release (#50).** MAJOR (1.x line).

- Shared orchestration package consumed by both `vivijure-cf` and `vivijure-local` via npm semver.
