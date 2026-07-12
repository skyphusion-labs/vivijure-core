# Architecture -- vivijure-core

One orchestration package, two thin hosts. This doc defines the boundary so the Cloudflare and Node
adoptions stay mechanical, not a rewrite.

## Layer model

```
+------------------------------------------------------------------+
|  HTTP routes, auth, AI chat/planner, RunPod submit, demo, MCP   |  HOST ONLY
|  (vivijure/src/index.ts, vivijure-local/src/routes/*)            |
+------------------------------------------------------------------+
|  Platform adapter: Env/bindings -> Platform                      |  HOST ONLY
|  CF: src/platform/cf-platform.ts (planned)                       |
|  Node: src/platform/* (sqlite, storage, modules, secrets)        |
+------------------------------------------------------------------+
|  @skyphusion-labs/vivijure-core                                  |  THIS REPO
|  registry, film-orchestrator, *-db, preflight, conformance, ICD  |
+------------------------------------------------------------------+
|  Module workers (26 hooks) + CPU/GPU backends                    |  UNCHANGED
|  vivijure-module/2 wire contract                                 |
+------------------------------------------------------------------+
```

## What lives in core

| Category | Examples | I/O pattern |
|----------|----------|-------------|
| Platform ICD | `platform/types.ts`, `orchestrator-context.ts` | Types only |
| Module contract | `modules/types.ts`, `registry.ts`, `conformance.ts` | `FetcherLike` inject |
| Pure models | `film-model.ts`, `clip-job-model.ts`, `preflight.ts` | None |
| Orchestrators | `film-orchestrator.ts`, `render-orchestrator.ts` | `OrchestratorEnv` |
| DB helpers | `cast-db.ts`, `renders-db.ts`, ... | `DbEnv` / `Database` |
| Bundle / tar | `bundle-assembler.ts`, `tar.ts`, `key-safety.ts` | `OrchestratorEnv` + presigner |

## What stays in hosts

| Concern | CF (`vivijure`) | Local (`vivijure-local`) |
|---------|-----------------|--------------------------|
| HTTP router | `src/index.ts` | `src/app.ts`, `src/routes/*` |
| Full `Env` / wrangler bindings | `src/env.ts` | N/A (uses `Platform`) |
| Platform implementation | `cfPlatformFromEnv()` (planned) | `src/platform/sqlite.ts`, `storage.ts`, ... |
| Presign SigV4 impl | `src/r2-presign.ts` | S3 presigner in `storage.ts` |
| Auth | `auth-gate.ts`, `access-auth.ts` | `auth-gate.ts` (token mode) |
| Planner HTTP scaffold | `planner.ts`, `providers/*` (legacy; migrate) | `planner.ts` + `routes/m7.ts` (module-driven) |
| RunPod submit | `runpod-submit.ts` | Host route or future adapter |
| Scatter pipeline | `scatter-orchestrator.ts` | TBD (Phase 4) |
| Static UI | Workers Assets | `public/` static serve |
| Operator docs | `docs/CONTRACT.md` (canon) | `docs/PARITY.md` |

## Import rules (both hosts)

1. **Orchestration imports from core subpaths**, not forked `src/film-orchestrator.ts`.
2. **Core never imports host `env.ts`.** Use `DbEnv`, `OrchestratorEnv`, or `Platform`.
3. **Presign:** core calls `env.PRESIGNER`; each host wires its own `ObjectPresigner`.
4. **Module registry:** build env bag via `orchestratorContextFromPlatform(platform)` or
   `platformAsEnv(platform)` before `discoverModules()`.
5. **VPC / AI / RunPod:** inject through `platform.hostBindings` or host-only wrappers; do not
   add CF-specific fields to `Platform` without bumping `PLATFORM_ICD_VERSION`.
6. **Thin re-export shims** in hosts are OK during migration (`export * from "@skyphusion-labs/vivijure-core/cast-db"`)
   but delete the shim once all call sites import core directly.

## Dependency graph (acyclic)

```
platform/types
  -> orchestrator-context -> presign, audio-stage, clip-*, film-*, renders-db, bundle-*
modules/types -> manifest-validate -> registry -> conformance, render-pipeline
clip-job-model -> film-model -> film-orchestrator -> film-render-bridge
```

Avoid package self-imports (`renders-db` must use `./film-advance-lease.js`, not the package name).

## Versioning

| Package | Pre-split | Post-split (target) |
|---------|-----------|---------------------|
| `vivijure-core` | `0.8.x` (extraction) | `1.0.0` when CF host deletes duplicates |
| `vivijure` | `0.x` CF-native | `2.0.0` depends on `vivijure-core@^1` |
| `vivijure-local` | `0.1.x` alpha | `2.0.0` depends on `vivijure-core@^1` |

Hosts pin semver once `vivijure-core` publishes to GitHub npm. Until then, sibling `file:../vivijure-core`.

## CI split

| Repo | Owns |
|------|------|
| `vivijure-core` | Platform contract tests, conformance, db-helpers, bundle-assembler, preflight |
| `vivijure-local` | Route integration, parity smoke, docker-build (checks out core sibling) |
| `vivijure` | Worker integration, module worker builds, upstream CONTRACT tests |

## Related docs

- [CORE-VS-MODULES.md](CORE-VS-MODULES.md) -- planner scaffold vs installed modules (canonical)
- [PLATFORM.md](PLATFORM.md) -- ICD field reference
- [HOST-ADOPTION.md](HOST-ADOPTION.md) -- step-by-step CF + local migration
- [EXTRACTION-STATUS.md](EXTRACTION-STATUS.md) -- file inventory and wave status
