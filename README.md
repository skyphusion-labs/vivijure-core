# @skyphusion-labs/vivijure-core

Shared orchestration for [Vivijure Studio](https://github.com/skyphusion-labs/vivijure): module
registry, film pipeline, planner helpers, and the **Platform ICD** that lets one codebase run on
Cloudflare Workers or a provider-neutral Node host.

| Consumer | Role |
|----------|------|
| [`vivijure`](https://github.com/skyphusion-labs/vivijure) | CF-native control plane (D1, R2, service bindings) |
| [`vivijure-local`](https://github.com/skyphusion-labs/vivijure-local) | Homelab control plane (SQLite, S3/MinIO, HTTP sidecars) |

**Status:** Alpha / Phase 3 extraction. `vivijure-local` already depends on this package.
`vivijure` (CF) still carries duplicate `src/` copies; adoption path is documented in
[docs/HOST-ADOPTION.md](docs/HOST-ADOPTION.md).

## Layout

```
src/
  platform/          Platform ICD + orchestratorContextFromPlatform()
  modules/           vivijure-module/2 contract, registry, conformance
  film-*.ts          Film + clip orchestration
  *-db.ts            D1-shaped metadata helpers (DbEnv)
  preflight.ts       Planner pre-render validation
  ...
docs/
  PLATFORM.md        Frozen adapter contract (ICD v1)
  ARCHITECTURE.md    Package boundary + dependency rules
  HOST-ADOPTION.md   CF + local host migration checklist
```

## Install (sibling clones)

Hosts expect this repo as a sibling of the host repo:

```
~/dev/
  vivijure-core/
  vivijure-local/    # package.json: "@skyphusion-labs/vivijure-core": "file:../vivijure-core"
  vivijure/          # future: same file: dep or published semver
```

```bash
cd vivijure-core
npm ci
npm run typecheck && npm test
```

## Key exports

| Entry | Contents |
|-------|----------|
| `@skyphusion-labs/vivijure-core` | Barrel: registry, orchestrators, conformance, ... |
| `@skyphusion-labs/vivijure-core/platform` | `Platform`, `orchestratorContextFromPlatform`, R2 shim |
| `@skyphusion-labs/vivijure-core/film-orchestrator` | Full film state machine |
| `@skyphusion-labs/vivijure-core/preflight` | Storyboard pre-render checks |

Full subpath list: `package.json` `exports` field.

## Platform ICD

Orchestration never touches Worker bindings or `process.env` directly. Hosts implement `Platform`
(see [docs/PLATFORM.md](docs/PLATFORM.md)) and pass `orchestratorContextFromPlatform(platform)`
into ported handlers.

## License

AGPL-3.0-only. Same as Vivijure Studio upstream.
