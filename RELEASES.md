# Releases -- @skyphusion-labs/vivijure-core

Shared orchestration library for [`vivijure-cf`](https://github.com/skyphusion-labs/vivijure-cf) and
[`vivijure-local`](https://github.com/skyphusion-labs/vivijure-local). A release is:

1. A version bump in `package.json` on `main`
2. An annotated git tag `vivijure-core-v<semver>` **pushed to origin**
3. A **GitHub Release** on that tag (`gh release create vivijure-core-v<semver> ...`)
4. npm publish via `.github/workflows/publish-npm.yml` (tag push or workflow_dispatch; requires
   repo secret `NPM_TOKEN`)

Tag prefix `vivijure-core-v` must match `package.json` version (workflow verifies on tag push).

## Cutting a release

```bash
# 1. Bump package.json version on main (via PR)
# 2. Tag + push
git tag vivijure-core-v1.2.2
git push origin vivijure-core-v1.2.2

# 3. GitHub Release (npm CI does NOT create this -- do it explicitly)
gh release create vivijure-core-v1.2.2 \
  --title "vivijure-core v1.2.2" \
  --notes-file /path/to/notes.md

# 4. Confirm npm publish workflow succeeded
gh run list --workflow publish-npm.yml --limit 3
npm view @skyphusion-labs/vivijure-core@1.2.2 version

# 5. CLOSE THE LEDGER ROW -- see "Closing the row" below. Not optional, not a tidy-up.
```

> **STANDING CONDITION, not a one-off. First instance v1.10.0 (2026-08-07).** The rule above says
> seed the ledger and `CHANGELOG.md` in the same PR as the version bump. **Once core#146's guard is
> in force, no cycle can.** After a release, `main` sits on a tagged version, so a bare
> `## Unreleased` is refused and the next FEATURE PR is the one that must open the next version.
> That is the steady state, not a deviation: the bump lands in the first feature PR of the cycle and
> the seed lands in the release PR. v1.10.0 was the first instance (bump in #169, seed in #170).
>
> **This does NOT reintroduce the per-PR version pin that broke #144.** A version opens ONCE per
> cycle. Every subsequent PR adds an entry under the already-open heading and touches no version
> file, so the spent-version assertion never fires again until the next release.

## Closing the row (step 5, and the one that gets skipped)

The ledger row is written in TWO moments against TWO different pieces of evidence, and only the
first has ever been reliable:

1. **SEEDED** in the version-bump PR: tag name, version, notes. Leave `source commit` and
   `published` EMPTY -- do not write `pending`. An empty cell reads as "nobody has filled this in";
   `pending` reads as a claim about the world, and it is a claim nobody checks.
2. **CLOSED** after the publish: fill `source commit` with the tag's commit and `published` with the
   date **the registry reports**.

```bash
# The tag was cut and pushed elsewhere -- you very likely do NOT have it locally. This step was
# missing from the first version of this procedure and the command below failed because of it.
git fetch --tags origin

TAG="vivijure-core-v<semver>"
# NOT `git rev-list ... | cut`: a pipeline returns the LAST command's status, so `cut` reports 0
# even when rev-list died on a missing tag -- the fix printed nothing and claimed success. Capture
# first, refuse loudly, then slice.
SHA="$(git rev-list -n 1 "$TAG")" || { echo "REFUSE: $TAG not found locally -- did the fetch run?"; exit 1; }
echo "source commit: ${SHA:0:7}"

# Published date, from the REGISTRY. Emits a full ISO timestamp; the ledger column takes the DATE.
npm view @skyphusion-labs/vivijure-core time --json | python3 -c \
  "import json,sys; print('published:', (json.load(sys.stdin).get('<semver>') or 'NOT PUBLISHED')[:10])"

npm view @skyphusion-labs/vivijure-core dist-tags.latest       # sanity: should be <semver>
npm view @skyphusion-labs/vivijure-core@9.9.9 version          # negative control: must be E404
```

**CI WILL NOT TELL YOU IF EITHER VALUE IS WRONG.** `tests/releases-ledger.test.ts` checks **SHAPE,
never correctness** -- not-`pending`, not-`(this PR)`, an ISO-date regex, a sha regex. **A
well-formed WRONG date passes it green**, and so does any 7-hex string in `source commit`. The
correctness of both cells rests entirely on the two commands above -- `git rev-list -n 1 <tag>` and
the registry's own `time` map -- and never on the suite. **Green here is not confirmation.**
(rollins, 2026-08-07)

**Both fixes above came from RUNNING this procedure rather than reading it**, on its second use and
the first where someone else supplied the confirmation. The original `git rev-list ... | cut -c1-7`
**failed and reported success**: the tag was not in the local clone, `rev-list` died, and `cut`
returned 0 for the pipeline. Anyone following it literally would have seen empty output, a zero exit
status, and had nothing to tell them the value they were about to paste into the ledger was missing.
A procedure whose failure mode is a silent empty string is the same defect the `published` column
had, one layer up.

**Settle it at the registry, never at the publish run.** A green workflow is not a published
package, and `npm view` has served a cached answer immediately after a publish before -- so the read
belongs AFTER the confirmation in step 4, as its own act, with a negative control proving the check
can come back absent.

WHY THIS IS A NUMBERED STEP RATHER THAN A NOTE. `published` used to be filled in at PR time, before
the fact, and never corrected -- so `pending` was the value for a published release and an
unpublished one alike, and the column could not answer the one question the ledger exists for. Every
`pending` row in this file was false when that was measured (`v1.6.0`, `v1.2.10`, `v1.2.7`;
`v1.2.14` had no row at all). See core#126.

Seed the ledger and `CHANGELOG.md` in the same PR as the version bump; CLOSE the ledger row once the
publish is confirmed at the registry.

**CI enforces the pretence half of this rule** (`tests/releases-ledger.test.ts`, core#126): the
ledger must not contain the literal `pending` in `published`, or `(this PR)` in `source commit`,
and a filled `published` cell must be `YYYY-MM-DD`. Empty cells (seeded, not yet closed) are fine.
The test does not call the registry -- step 5 above is still a human act after `npm view`.

## Release ledger

**`published` is the npm publish date in UTC.** Take it from `npm view <pkg> time` and read the
date off the `Z` timestamp, not off a local clock. This is not pedantry: v1.12.0 published at
`2026-08-14T03:39:03.710Z`, which is `2026-08-13` in US Central and `2026-08-14` in CEST. A row
filled from a local clock reads plausibly in isolation and is wrong, and nothing in this file would
catch it -- `tests/releases-ledger.test.ts` asserts only `/^\d{4}-\d{2}-\d{2}$/`, so a well-formed
wrong date passes green.

**The convention was already implemented; only its name was missing.** Step 5 of the closing
procedure above runs `npm view <pkg> time --json` and slices `[:10]`, and every timestamp the
registry returns is `Z`-suffixed, so that slice is a UTC date unconditionally. This paragraph names
what the procedure already does, so that a row filled by hand cannot disagree with a row filled by
the command.

**Measured against the whole ledger, not just the newest rows:** re-deriving all 31 rows' dates from
the npm publish epochs, UTC matches **31 of 31**. US Central matches 21, CEST matches 28, and a
UTC+14 control matches 11. So 13 rows discriminate between zones -- Central falsifies 10 of them and
CEST falsifies 3. The convention is not a coincidence that has held twice; it is the only zone
consistent with the file.

| git tag | npm | source commit | published | notes |
|---|---|---|---|---|
| `vivijure-core-v1.13.0` | 1.13.0 | 9cd62f2 | 2026-08-14 | **MINOR.** Presigned satellite inputs for the finish and speech chains (cf#312, #154): the core presigns GET/PUT and hands them on `FinishInput` / `SpeechInput`, so `finish-upscale` / `finish-lipsync` / `speech-upscale` can call a satellite's credentialless branch instead of the shared-bucket one, which is what unblocks endpoint pooling. **The satellites select R2-vs-presigned on the PRESENCE of `clip_key` / `audio_key`, never on URL presence, so a module building the presigned body must OMIT the key -- sending both takes the R2 branch, the render SUCCEEDS, and nothing reports that the credentialless path was never exercised.** The `.hash` provenance sidecar is presigned at `<output_key>.hash`, the key the #583 adoption gate reads. Also: the cron sweep rotates its window so the newest films are reached rather than starved (#180), and reports coverage; the storage reconcile is stage-and-swap so a killed rebuild cannot certify a partial ledger (cf#516); and a reconcile now records how many objects it could not size, so a FLOOR stops reading as a TOTAL (core#183 family). **Consumers pin `^1.11.0` and must repin to pick any of this up.** |
| `vivijure-core-v1.12.0` | 1.12.0 | d31c269 | 2026-08-14 | **MINOR.** Film submit gets an idempotency guard (cf#518, #184): a client-supplied `idempotency_key` on both entry points, plus a natural-key backstop over a 60-second window for paths that cannot be changed (MCP, scatter). Both mint sites are in core, so a cf-side guard would knowingly leave `vivijure-local` and the scatter path exposed against the two-panel parity invariant. Also: the changelog-version guard now refuses Unreleased work on an already-tagged version (core#119, #146) -- it needs `fetch-tags: true` in CI to be non-vacuous, which ships with it. |
| `vivijure-core-v1.11.0` | 1.11.0 | 233ff1b | 2026-08-13 | **MINOR.** An explicit `model_family` is HONOURED rather than silently substituted (core#174). `resolveCastTrainFamily`'s explicit-`"wan"` branch and its fallthrough were the identical expression, so `model_family: "wan"` was byte-identical to sending nothing; on an unwired host the server returned **200 having trained SDXL** after the panel quoted the user a Wan job at a different duration and price. Explicit `"wan"` now returns `"wan"` and `executeCastTrain`'s shipped 501 refuses. **Consumer-visible:** `POST /train-lora` with explicit `"wan"` on an unwired host goes 200 -> **501, no job submitted**; neither panel handles 501 on that button yet (vivijure-cf#420, vivijure-local#346, vivijure-local#329). Default path, explicit `"sdxl"`, and explicit `"wan"` on a wired host are unchanged. |
| `vivijure-core-v1.10.0` | 1.10.0 | f6ebdcd | 2026-08-07 | **MINOR.** RunPod reached through the control-plane proxy when `RUNPOD_PROXY_BASE` is bound; direct `RUNPOD_API_KEY` route retained permanently as the self-host door (cp#321 step 1, #169). `src/runpod-route.ts` MOVED from `vivijure-cf`'s `modules/_shared/` so both hosts CAN import one implementation -- **no host imports it in this release**; cf adoption is cp#321 step 2 and is not shipped here. Also opens the version and repairs a lockfile left at 1.8.1 by the v1.9.0 cut. |
| `vivijure-core-v1.9.0` | 1.9.0 | 8702fdd | 2026-08-07 | **MINOR.** Homelab SDXL cast train via `LOCAL_BACKEND_URL` (`submitTrainLoraJob` / `pollCastLoraJob`); packages with cf#460 deterministic tar mtime. GitHub Release: [vivijure-core v1.9.0](https://github.com/skyphusion-labs/vivijure-core/releases/tag/vivijure-core-v1.9.0). |
| `vivijure-core-v1.8.1` | 1.8.1 | 6fd34ab | 2026-08-06 | **PATCH.** Post-1.8.0 main: PollResponse failure fields (#160), keyframe provenance `bundle_key` (#151 / cf#388), render `motion_backend`/`keyframe_backend` (#147 / cf#393; REQUIRES cf migration 0018 before host pin), scatter D1-empty dialogue fallback (#142 / core#122), docs audit (#158). GitHub Release: [vivijure-core v1.8.1](https://github.com/skyphusion-labs/vivijure-core/releases/tag/vivijure-core-v1.8.1). |
| `vivijure-core-v1.8.0` | 1.8.0 | 9ef47e5 | 2026-08-06 | **MINOR.** Open version (#159) + finish_elapsed_ms (cf#268/#145; REQUIRES cf migration 0017), FilmSummary assemble_ms/output_ms (#152), cast per-family LoRA readiness (#150), install-patch dropped keys (#148), untrained LoRA voice path (#156), clips content gate (#143), modules.d.ts/RELEASES guards (#149), drop dead sync:module-types (#157). GitHub Release: [vivijure-core v1.8.0](https://github.com/skyphusion-labs/vivijure-core/releases/tag/vivijure-core-v1.8.0). |
| `vivijure-core-v1.7.3` | 1.7.3 | 34d2f84 | 2026-08-05 | **PATCH: dependency updates and docs (CLAUDE release procedure) on main since 1.7.2.** Hosts (cf/local) should pin after this lands. GitHub Release: [vivijure-core v1.7.3](https://github.com/skyphusion-labs/vivijure-core/releases/tag/vivijure-core-v1.7.3). PR #136. |
| `vivijure-core-v1.7.2` | 1.7.2 | 5b846c4 | 2026-08-03 | **`film.finish` lost the delivered length and prepend on the ADOPTED completion path (#131, #132; core#130, #663; vivijure-cf#268).** `runFilmFinish` checks R2 for a step's deterministic artifact before checking the poll token, so a container PUT between polls ADOPTS the artifact and never reads its output -- the only place the delivered length and any title-card prepend travel. Adoption is the NORMAL completion route, not an edge case, and #124 filed the loss as a rare residual; it fired on the first real render as a NULL `output_ms` on a COMPLETED, billed film. Fix is a measurement sidecar (`metaKeyFor` / `readStepMeta`) written next to the artifact and read back on adoption, mirroring the existing `.srt` sidecar; absent/unreadable/malformed still lands on NULL, never a synthesized length. Additive, optional (`meta_url` / `meta_key`), no module-contract epoch bump. READING half only -- the container's write half is merged (vivijure-cf#370) and built (image `d26db499`) but not yet running in production: the swarm stack still pins the prior digest (`0434011`), which predates the sidecar, pending a repin. PATCH: neither new export is a deliberate consumer-facing API, both exist to serve `runFilmFinish` internally. Leaves core#119 open (the changelog/version guard gap that let #131/#132 sit unreleased past 1.7.1). |
| `vivijure-core-v1.7.1` | 1.7.1 | c07b53e | 2026-08-02 | **`renders.output_ms` was WRITE-ONLY (vivijure-cf#268).** 1.7.0 shipped the capture and added the column to NO read path -- not `RENDER_ROW_COLUMNS`, not `RawRenderRow`, not `normalizeRow` -- so the metering basis was written and then unobservable by the panel, by the meter that will bill on it, and by the smoke meant to prove it landed; only an account-credentialled D1 query could see it. Added at every missing hop (`PublicRenderRow` needed none: it spreads). It survived a full suite because every 1.7.0 test asserted the WRITE through a stubbed D1 binding -- a capture path with no reader passes every test that only exercises capture. The new suite drives the real read functions, asserts the SQL column list, and fails on 1.7.0 in all six cases. NULL stays NOT MEASURED, never coalesced to 0. |
| `vivijure-core-v1.7.0` | 1.7.0 | 705a628 | 2026-08-02 | **The DELIVERED film length -> `renders.output_ms` (vivijure-cf#268, vivijure#805).** PR #124. Conrad's metering basis is "we bill on the last writer": a carded film is longer than its assemble output, so billing assemble under-bills by every title card. `film_output_seconds` maps FILM ARTIFACT KEY -> measured seconds and every stage that writes a film records into it, so the delivered length is a LOOKUP OF THE FINAL KEY -- last-writer-wins as a property of the data, not an ordering rule. Persisted because the `film.finish` chain ADOPTS an artifact already in R2 (#600) with NO container call, so a live-result-only read loses the length on exactly the films long enough to span ticks, as a NULL on a COMPLETED row that bills nothing. `markFinishDone` gains optional `outputMs`; `COALESCE(?, output_ms)` is last-writer-wins, not a first-writer guard. **BEHAVIOUR CHANGE: `film.finish` conformance now REJECTS `duration_seconds <= 0`** -- a module that cannot measure must OMIT the field. Caught a real regression in vivijure-cf#359 (subtitle's sidecar-only run puts a `0.0` initialiser on the wire). REQUIRES vivijure-cf migration `0016` applied before the dep bump. |
| `vivijure-core-v1.6.0` | 1.6.0 | 0e8342a | 2026-08-02 | **`dialogue_lines` on `startFilmFromKeyframes` (vivijure-cf#334) + the core#122 scatter comment.** The finalize family (render-from-keyframes, finalize, animate-cloud, animate-hybrid, on BOTH hosts) could not produce a voiced film at all: the parameter did not exist and the job literal never set the field, while `enterFinishPhase` reads `job.dialogue_lines` for the #584 dialogue-aware finish order and then calls `enterDialogueOrFinish`. A from-keyframes job enters at phase `clips` and the clips advance is `derive_mode` agnostic, so both were reached on every such render: the field was read and never written. Additive, so a caller that passes nothing gets a byte-identical job doc to 1.5.0; ids are joined with the same `coerceDialogueLineIds` as `startFilmJob` (#563). Also corrects the `startScatterRender` comment claiming the bundle is lossy for dialogue, false since #307/#313 and measured false against 16 of 62 production bundles. UNBLOCKS the vivijure-cf#334 single-render-door extraction, which cannot be honest for those doors until this ships. |
| `vivijure-core-v1.5.0` | 1.5.0 | 921d667 | 2026-08-01 | **Per-job tenant R2 credential on the invoke envelope (cp#270).** PR #117 (feature) + #118 (release). Pooling the hosted shared tier means one RunPod endpoint serves many tenants, so the tenant R2 destination can no longer live in the endpoint template env; it arrives per job on `InvokeRequest.r2`, for a module whose manifest declares `needs_tenant_r2`. BOUNDED residency chosen over STANDING: binding the credential onto every tenant module script would put each copy on the credential-roll list forever with a silent staleness mode (vivijure-cf#83 is that bug having already happened). `withTenantR2` OMITS the key rather than nulling it (the backend REFUSES an explicit null); `takeTenantR2` strips it on receipt, mirroring the backend `strip_from_payload`. `InvokeContext` stays literally "never secrets" because `r2` is a SIBLING of it. Additive: a module that does not declare the field gets a byte-identical envelope to 1.4.0. STANDING CONDITION: enabling Logpush Custom Fields on tenant module workers requires revisiting the design. |
| `vivijure-core-v1.4.0` | 1.4.0 | a346403 | 2026-07-28 | **`R2_STORAGE_QUOTA_MODE` (cp#195).** PR #106. The bytes ceiling can be an INCLUDED quota (`meter`) instead of a hard cap; `deny` is the default and byte-identical to core#52, pinned by a six-input control over exact message strings. Carries the completeness contract (`complete` / `reason`, the LLM meter vocabulary) and the ledger-truth marker: a readable total is not a TRUE total, so `meter` reports unbillable until a reconcile runs or a host stamps at studio creation. The LLM allowance knob was built for this release and PULLED before tagging (no core consumer); parked whole on core#107. |
| `vivijure-core-v1.3.0` | 1.3.0 | 1cf27d8 | 2026-07-27 | **Storage accounting + `R2_STORAGE_QUOTA_BYTES` (core#52).** PRs #98 (feature) + #99 (generic wrappers, so a host store keeps its type through the metering seam). Also carries `host.hooks_unavailable` (vivijure-cf#98) and the silent-shot lip-sync omission fix (#82). Parity train with vivijure-cf v1.11.0 + vivijure-local v1.5.0. |
| `vivijure-core-v1.2.13` | 1.2.13 | 424e418 | 2026-07-24 | **Fix: cast-LoRA stuck-training reconciler (core#92)** no longer false-fails an observed-running Wan train; adversarial-audit CI. *(Row backfilled 2026-07-25 -- the release shipped without one.)* |
| `vivijure-core-v1.2.12` | 1.2.12 | 05ea36b | 2026-07-23 | **K3 closeout (core#89).** Reject unsafe GPU `output_key` in `updateRenderFromView`. |
| `vivijure-core-v1.2.11` | 1.2.11 | 04fa4b3 | 2026-07-23 | **Fix: validate audioKey in stageAudioKeyForRenders (KF3 audit).** PATCH. Predates #89 merge. |
| `vivijure-core-v1.2.10` | 1.2.10 | 8da2725 | 2026-07-23 | **KF3 tar path safety (core#86).** `emitTar` / `readTar` reject `..` traversal via `isSafeRelKey`. |
| `vivijure-core-v1.2.9` | 1.2.9 | f4084c6 | 2026-07-23 | **KF3 cast train family parse (core#84).** Honor `wanConfigured` when train fields live only in `renderOverrides`. |
| `vivijure-core-v1.2.8` | 1.2.8 | 5df0d4f | 2026-07-23 | **Default cast `/train-lora` to Wan train EP when wired (cf#29 Phase E).** SDXL escape via `model_family:"sdxl"`. Tag predates #84 merge; npm 1.2.8 matches tag commit before KF3 fix. |
| `vivijure-core-v1.2.7` | 1.2.7 | 129ff36 | 2026-07-22 | **Local-GPU keyframe coupling (vivijure-local#153).** When motion is locality `local`, default/require a local keyframe module; `localGpuKeyframePreflightError`; dedicated keyframe modules keep the global default pick. |
| `vivijure-core-v1.2.6` | 1.2.6 | 0f0f796 | 2026-07-22 | **Adopt-render auth hardening (core#76/#77).** Safe `outputKey` under `renders/<jobId>/`; INSERT winner-only finish; no overwrite of existing rows. |
| `vivijure-core-v1.2.5` | 1.2.5 | 632b556 | 2026-07-22 | **Film phase `from` on cold isolate (cf#110) + `HookCatalogEntry.order` (core#54).** Panels drop hardcoded HOOK_ORDER. |
| `vivijure-core-v1.2.4` | 1.2.4 | 1d9923d | 2026-07-22 | **Pre-submit RunPod idle workersMax reconcile (cf#61).** REST GET/PATCH restore when management keys allow; honest guidance for scoped invoke keys. Ships core#69. |
| `vivijure-core-v1.2.3` | 1.2.3 | fed694e | 2026-07-21 | **#53 advanceFilmJob wedge -> terminal fail** (core#64) + **COMPLETED renders stamp `output_key`** when `film.mp4` exists (local#99, core#65). |
| `vivijure-core-v1.2.2` | 1.2.2 | 62c7864 | 2026-07-21 | **Finish-order default reverted (cf#29).** Dialogue shots use legacy `ui.order` (RIFE -> lipsync -> upscale). #584 reorder opt-in via `finish_config["finish-order"].dialogue_reorder`. Ships core#62. |
| `vivijure-core-v1.2.1` | 1.2.1 | 01720e4 | 2026-07-20 | **Wan LoRA poll writeback fix (cf#29).** `fix(cast-lora): poll Wan train EP for harvest writeback` (#59). |
| `vivijure-core-v1.2.0` | 1.2.0 | 0dd5626 | 2026-07-20 | **Portable Wan i2v LoRA support (Phases B+C, cf#29).** Wan 2.2 A14B helpers, cast columns, train orchestration + poller (#56, #57, #58). |
| `vivijure-core-v1.1.0` | 1.1.0 | ff4799a | 2026-07-18 | **`image.generate` hook (cf#129 phase 2).** Module contract extension (#55). |
| `vivijure-core-v1.0.0` | 1.0.0 | 8e1f9b2 | 2026-07-16 | **Constellation stable line (#50).** First 1.x release; both hosts consume published npm package. |

Older pre-1.0 tags (`vivijure-core-v0.9.x`) were published to npm during extraction; see git tags for
history. GitHub Releases were not backfilled for 0.9.x.
