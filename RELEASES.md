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
```

Update this ledger and `CHANGELOG.md` in the same PR as the version bump (or a follow-up PR before
tagging the next release).

## Release ledger

| git tag | npm | source commit | published | notes |
|---|---|---|---|---|
| `vivijure-core-v1.2.12` | 1.2.12 | 05ea36b | 2026-07-23 | **K3 closeout (core#89).** Reject unsafe GPU `output_key` in `updateRenderFromView`. |
| `vivijure-core-v1.2.11` | 1.2.11 | 04fa4b3 | 2026-07-23 | **Fix: validate audioKey in stageAudioKeyForRenders (KF3 audit).** PATCH. Predates #89 merge. |
| `vivijure-core-v1.2.10` | 1.2.10 | (this PR) | pending | **KF3 tar path safety (core#86).** `emitTar` / `readTar` reject `..` traversal via `isSafeRelKey`. |
| `vivijure-core-v1.2.9` | 1.2.9 | f4084c6 | 2026-07-23 | **KF3 cast train family parse (core#84).** Honor `wanConfigured` when train fields live only in `renderOverrides`. |
| `vivijure-core-v1.2.8` | 1.2.8 | 5df0d4f | 2026-07-23 | **Default cast `/train-lora` to Wan train EP when wired (cf#29 Phase E).** SDXL escape via `model_family:"sdxl"`. Tag predates #84 merge; npm 1.2.8 matches tag commit before KF3 fix. |
| `vivijure-core-v1.2.7` | 1.2.7 | (this PR) | pending | **Local-GPU keyframe coupling (vivijure-local#153).** When motion is locality `local`, default/require a local keyframe module; `localGpuKeyframePreflightError`; dedicated keyframe modules keep the global default pick. |
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
