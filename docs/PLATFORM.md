# Platform interface (frozen ICD v1)

This document freezes the **host adapter contract** between Vivijure orchestration logic
(`vivijure-core`) and a runtime (`vivijure-local` Node host, `vivijure` Cloudflare host).

**Source of truth:** `src/platform/types.ts` in this repo (no Node/Workers imports).

**Version:** `PLATFORM_ICD_VERSION = 1` (bump only with a coordinated release across `vivijure-core`,
`vivijure`, and `vivijure-local`).

## Aggregated surface

| Field | Role | CF binding | Local implementation |
|-------|------|------------|----------------------|
| `db` | Metadata (projects, cast, renders rows) | D1 `DB` | SQLite (`src/platform/sqlite.ts`) |
| `renders` | Film job docs, clips, bundles | R2 `R2_RENDERS` | S3/MinIO or filesystem |
| `chatBucket` | Chat-side artifacts | R2 `R2` | Same store or alias |
| `presigner` | Presigned GET/PUT for modules/CPU | `r2-presign.ts` | S3 SigV4 or local token URLs |
| `secrets` | API keys, tokens | Secrets Store + wrangler | SQLite `platform_secrets`: install seeds `STUDIO_API_TOKEN`; Settings edits provider keys (S3/R2, AI Gateway, Anthropic, RunPod, …) |
| `modules` | Module invoke transport | `MODULE_*` service bindings | HTTP sidecars (`MODULE_*_URL`) |
| `rateLimiter` | Spend guard (optional) | Durable Object / KV | In-memory (local v1) |
| `scheduler` | Render sweep cron (optional) | `scheduled()` | `node-cron` (when wired) |
| `vars` | Plain config (`AUTH_MODE`, storage backend, etc.) | Worker env | `process.env` subset |
| `hostBindings` | Optional extra fetchers (VPC, etc.) | Worker service bindings | Node HTTP VPC shim (`Platform.hostBindings`) |

## Orchestrator context (M18)

Ported orchestrators accept a Cloudflare-shaped `OrchestratorEnv` bag (`DB`, `R2_RENDERS`,
`PRESIGNER`, module binding keys). **Core** builds it via `orchestratorContextFromPlatform(platform)`
(`@skyphusion-labs/vivijure-core/platform`). **Node host** sets `platform.hostBindings` from merged
runtime env during boot/reload (VPC URL shim). **CF host** maps native service bindings the same way.

Routes and DB helpers call `orchestratorContextFromPlatform(platform)` directly; there is no
host-side env bridge module.

## Host obligations

1. Implement every **required** `Platform` field before film render routes go live.
2. Mirror upstream `CONTRACT.md` HTTP behavior; platform adapters must not change wire shapes.
3. Module transport: `listBindings()` returns installed `MODULE_*` names; `resolve()` returns a
   `FetcherLike` that speaks `vivijure-module/2` over HTTP or service binding.
4. Object store: `get` / `put` / `head` / `delete` semantics match R2 subset used by orchestrators.
5. `list(prefix)` **should** return per-object metadata inline via `objects: ObjectListEntry[]` (each
   `{ key, uploaded?, size? }`) when the host already has it (S3 `ListObjectsV2` carries `LastModified`).
   The R2-compat adapter then skips a HEAD per key. Returning only `{ keys }` stays conformant -- the
   adapter falls back to a HEAD per key (correct, just slower). Additive/optional: no ICD version bump.
   Provide `uploaded` so the freshness-floor reclaim (#661/#19) can run; without it, floored reclaim
   safely excludes the object (re-render) rather than risk adopting a stale prior-run artifact.

## Non-goals (v1 ICD)

- Workers for Platforms dynamic dispatch (CF-only; local uses static sidecar URLs).
- CF Access identity on `Platform` (auth stays host-router concern).
- Tail / Loki observability bindings.

## Change control

1. Edit `src/platform/types.ts`.
2. Bump `PLATFORM_ICD_VERSION` and this doc.
3. Update `tests/platform-contract.test.ts` in this repo.
4. Land in `vivijure-core`, then bump the dependency in both hosts before either ships a release
   that depends on the new shape.
