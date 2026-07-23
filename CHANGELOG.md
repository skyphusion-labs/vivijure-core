# Changelog

Notable changes per `@skyphusion-labs/vivijure-core` release. Tag + npm publish details live in
[`RELEASES.md`](RELEASES.md). Entries are newest-first.

## Unreleased

(none)

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
