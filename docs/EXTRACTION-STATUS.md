# Extraction status

Inventory of orchestration moved from host `src/` into `@skyphusion-labs/vivijure-core`.
Canonical upstream reference: `skyphusion-labs/vivijure` `main`.

## Waves (complete in core)

| Wave | Files | Notes |
|------|-------|-------|
| 0 | `modules/types.ts`, `conformance.ts`, `manifest-validate.ts`, `structured-events.ts`, `beat-sync-types.ts` | `types.ts` must match vivijure `main` |
| 1 | `modules/registry.ts`, `render-pipeline.ts` | `FetcherLike` from platform ICD |
| 2 | `film-model.ts`, `clip-job-model.ts`, `storyboard-ids.ts` | Pure shapes |
| 3 | `film-orchestrator.ts`, `render-orchestrator.ts`, `film-render-bridge.ts`, `clip-validate.ts`, `render-module-config.ts`, `runpod-types.ts`, `clip-content-validate.ts` | `OrchestratorEnv` |
| 4 | `cast-db.ts`, `storyboard-projects-db.ts`, `renders-db.ts`, `render-log.ts`, `public-id.ts`, `db-env.ts` | `DbEnv` |
| 5 | `bundle-assembler.ts`, `bundle-durations.ts`, `storyboard-validate.ts`, `planner-yaml.ts`, `tar.ts`, `key-safety.ts`, `presign.ts`, `lora-keys.ts`, `film-advance-lease.ts` | Bundle + tar |
| 6 | `preflight.ts`, `planner-prompt.ts`, `output-extract.ts` | Planner pure helpers |
| Platform | `platform/types.ts`, `orchestrator-context.ts`, `object-store-r2.ts`, `r2-types.ts`, `fetcher.ts` | ICD v1 |

## Host duplicate status

| Host | Duplicates in `src/` | Target |
|------|----------------------|--------|
| `vivijure-local` | Thin re-export shims only | Delete shims; import core directly (optional cleanup) |
| `vivijure-cf` | None (adopted `@skyphusion-labs/vivijure-core`) | Done |

## Not yet extracted (host-only today)

| File(s) | Host | Future |
|---------|------|--------|
| `beat-analyze.ts` (orchestration half) | core **extracted** | CF delete on adoption |
| `scatter-orchestrator.ts` | core **extracted** | CF delete on adoption |
| `audio-routing.ts` | core has copy; vivijure host duplicate | CF delete on adoption |
| `operator-config.ts` | core | CF delete on adoption |
| `dialogue-lines.ts` | core **extracted** | CF delete on adoption |
| `cast-media.ts` routes | vivijure host | Stays host (HTTP) |

## Tests in this repo

`tests/platform-contract.test.ts`, `conformance.test.ts`, `db-helpers.test.ts`,
`bundle-assembler.test.ts`, `preflight.test.ts`, `film-render-bridge.test.ts`

## Sync commands

```bash
# Module contract from upstream CF repo (sibling clone required)
npm run sync:module-types
```
