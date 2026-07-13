# @skyphusion-labs/vivijure-core

Shared orchestration for [Vivijure Studio](https://github.com/skyphusion-labs/vivijure): module
registry, film pipeline, planner helpers, and the **Platform ICD** that lets one codebase run on
Cloudflare Workers or a provider-neutral Node host.

| Consumer | Role |
|----------|------|
| [`vivijure`](https://github.com/skyphusion-labs/vivijure) | CF-native control plane (D1, R2, service bindings) |
| [`vivijure-local`](https://github.com/skyphusion-labs/vivijure-local) | Homelab control plane (SQLite, S3/MinIO, HTTP sidecars) |

**Status:** Parity with `vivijure` orchestration established (see [docs/PARITY.md](docs/PARITY.md)).
Published on npm as `@skyphusion-labs/vivijure-core`. `vivijure-local` consumes semver; `vivijure` (CF)
still carries duplicate `src/` copies until [docs/HOST-ADOPTION.md](docs/HOST-ADOPTION.md).

## Layout

```
src/
  platform/          Platform ICD + orchestratorContextFromPlatform()
  modules/           vivijure-module/2 contract, registry, conformance
  film-*.ts          Film + clip orchestration
  mcp*.ts            Studio MCP (stateless HTTP proxy for agents; any host)
  *-db.ts            D1-shaped metadata helpers (DbEnv)
  preflight.ts       Planner pre-render validation
  ...
docs/
  PLATFORM.md        Frozen adapter contract (ICD v1)
  ARCHITECTURE.md    Package boundary + dependency rules
  CORE-VS-MODULES.md Planner scaffold vs swappable modules (canonical)
  HOST-ADOPTION.md   CF + local host migration checklist
```

## Install

**npm (consumers):**

```bash
npm install @skyphusion-labs/vivijure-core
```

**Sibling clone (vivijure-local / vivijure dev):**

```
~/dev/
  vivijure-core/
  vivijure-local/    # package.json: "^0.9.0" — override with file:../vivijure-core locally
  vivijure/
```

```bash
cd vivijure-core
npm ci
npm run build   # emits dist/ (also runs on npm install via prepare)
npm run typecheck && npm test
```

**Publish** (maintainers): merge to `main`, ensure repo secret `NPM_TOKEN` is set, then:

```bash
git tag vivijure-core-v0.9.0
git push origin vivijure-core-v0.9.0
```

Or trigger the **Publish npm package** workflow manually after bumping `package.json` version.

**flatliners** (Hetzner test box): clone/pull from GitHub `main` via `gh`, not laptop rsync.
See [docs/FLATLINERS-DEV.md](docs/FLATLINERS-DEV.md) and `scripts/flatliners-sync.sh`.

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
