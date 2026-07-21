# Changelog

Notable changes per `@skyphusion-labs/vivijure-core` release. Tag + npm publish details live in
[`RELEASES.md`](RELEASES.md). Entries are newest-first.

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
