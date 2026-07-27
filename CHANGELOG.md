# Changelog

Notable changes per `@skyphusion-labs/vivijure-core` release. Tag + npm publish details live in
[`RELEASES.md`](RELEASES.md). Entries are newest-first.

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
