# CLAUDE.md -- vivijure-core

## What this is

**Shared orchestration** for Vivijure Studio: module registry, film/clip pipeline, planner helpers,
platform ICD. Two thin hosts consume this package:

| Host | Repo | Runtime |
|------|------|---------|
| CF-native | `skyphusion-labs/vivijure-cf` | Workers, D1, R2, service bindings |
| Local | `skyphusion-labs/vivijure-local` | Node, SQLite, S3/MinIO, HTTP sidecars |

Wire contract for HTTP routes stays in `vivijure-cf/docs/CONTRACT.md`. Module wire contract
is `src/modules/types.ts` (`vivijure-module/2`). **Planner vs module boundary:**
[docs/CORE-VS-MODULES.md](docs/CORE-VS-MODULES.md) (control plane = thin planner scaffold + module host).

## Rules

- **Core never imports host env.** No `./env`, no `@cloudflare/workers-types`, no `process.env` reads.
  Orchestration uses `Platform`, `DbEnv`, or `OrchestratorEnv` from `@skyphusion-labs/vivijure-core/platform`.
- **Module contract is sacred.** `src/modules/types.ts` is the **canonical** `vivijure-module/2`
  contract; module workers and hosts vendor it *from* here. Bump the epoch only with a coordinated
  release across every consumer. (Extraction is complete: `vivijure-cf` adopted the published package,
  so there is no inbound sync -- core is the source of truth.)
- **Platform ICD:** `src/platform/types.ts` is the frozen adapter contract (`PLATFORM_ICD_VERSION`).
  Bump version + `docs/PLATFORM.md` + contract tests before either host ships a release that depends
  on the new shape.
- **Subpath imports for hosts.** Prefer `@skyphusion-labs/vivijure-core/film-orchestrator` over deep
  relative paths into `node_modules`. Keeps CF and local hosts aligned.
- **No HTTP routers here.** Routes, auth, AI providers, RunPod submit, scatter, demo mode stay in hosts.

## Commands

```bash
npm run typecheck
npm test
```

## Release

SemVer pre-1.0 (`0.MINOR.PATCH`). Hosts pin `^0.8.0` until v2.0 coordinated release. Publish target:
GitHub npm registry (`@skyphusion-labs/vivijure-core`).

## Crew identity

Cursor/rancid work: commits as `Conrad Rockenhaus <conrad@skyphusion.org>`. Branch + PR; never push
to `main` unless Conrad says so.
