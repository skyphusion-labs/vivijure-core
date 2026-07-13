# Extraction status

Inventory of orchestration moved from the host `src/` into `@skyphusion-labs/vivijure-core`.

> **Status: COMPLETE.** All orchestration below lives in this package. `vivijure-cf` adopted the
> published `@skyphusion-labs/vivijure-core` and carries **no duplicate orchestration `src/`**;
> `vivijure-local` consumes it via semver. `vivijure-core` is now the canonical source of the module
> contract (`src/modules/types.ts`) -- module workers and hosts vendor it *from* here, there is no
> inbound sync. This inventory is kept as the historical record of what moved.

## Waves (in core)

| Wave | Files | Notes |
|------|-------|-------|
| 0 | `modules/types.ts`, `conformance.ts`, `manifest-validate.ts`, `structured-events.ts`, `beat-sync-types.ts` | `types.ts` is the canonical `vivijure-module/2` contract |
| 1 | `modules/registry.ts`, `render-pipeline.ts` | `FetcherLike` from platform ICD |
| 2 | `film-model.ts`, `clip-job-model.ts`, `storyboard-ids.ts` | Pure shapes |
| 3 | `film-orchestrator.ts`, `render-orchestrator.ts`, `film-render-bridge.ts`, `clip-validate.ts`, `render-module-config.ts`, `runpod-types.ts`, `clip-content-validate.ts` | `OrchestratorEnv` |
| 4 | `cast-db.ts`, `storyboard-projects-db.ts`, `renders-db.ts`, `render-log.ts`, `public-id.ts`, `db-env.ts` | `DbEnv` |
| 5 | `bundle-assembler.ts`, `bundle-durations.ts`, `storyboard-validate.ts`, `planner-yaml.ts`, `tar.ts`, `key-safety.ts`, `presign.ts`, `lora-keys.ts`, `film-advance-lease.ts` | Bundle + tar |
| 6 | `preflight.ts`, `planner-prompt.ts`, `output-extract.ts` | Planner pure helpers |
| Platform | `platform/types.ts`, `orchestrator-context.ts`, `object-store-r2.ts`, `r2-types.ts`, `fetcher.ts` | ICD v1 |

## Host status

| Host | Orchestration in host `src/` | State |
|------|------------------------------|-------|
| `vivijure-cf` | None (adopted `@skyphusion-labs/vivijure-core`) | Done |
| `vivijure-local` | Thin re-export shims only | Done (optional cleanup: import core directly) |

## Host-only surfaces (never move to core)

HTTP routers, auth, AI providers, RunPod submit transport, demo mode, and `cast-media` routes stay in
each host. See [HOST-ADOPTION.md](HOST-ADOPTION.md) "What never moves to core".

## Tests in this repo

`tests/platform-contract.test.ts`, `conformance.test.ts`, `db-helpers.test.ts`,
`bundle-assembler.test.ts`, `preflight.test.ts`, `film-render-bridge.test.ts`

## Module manifests for tests

The `quality-tier-drift` test resolves module worker manifests from a sibling `vivijure-cf` checkout
(CI sparse-checks it out into `vivijure/`; local dev uses a `../vivijure-cf` sibling). See
`vitest.config.ts`.
