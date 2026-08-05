# Host adoption -- vivijure-core

> **Status: COMPLETE.** `vivijure-cf` (the Cloudflare host) has adopted the published
> `@skyphusion-labs/vivijure-core` and carries no duplicate orchestration `src/`; `vivijure-local`
> consumes it via semver. The phases below are kept as the historical migration record.

Checklist for wiring **vivijure-cf** (Cloudflare) and **vivijure-local** (Node) onto
`@skyphusion-labs/vivijure-core` with minimal churn.

## vivijure-local (Node) -- done

| Step | Status |
|------|--------|
| Depend on `@skyphusion-labs/vivijure-core` (published semver; optional `file:` for local dev) | done |
| Implement `Platform` in `src/platform/*` | done |
| Routes call `orchestratorContextFromPlatform(platform)` | done |
| Host `src/*` files are thin re-exports into core | done (M18-M21) |
| Core package lives in sibling repo | done |
| Delete `packages/vivijure-core` workspace copy | done |

Local dev layout:

```
~/Documents/GitHub/
  vivijure-core/
  vivijure-local/
```

```bash
cd vivijure-local && npm ci && npm run typecheck && npm test
```

Docker / CI: build context includes both repos (see `vivijure-local/Dockerfile` and
`.github/workflows/ci.yml`).

---

## vivijure-cf (Cloudflare) -- done (phases below are the historical plan)

**Complete.** `vivijure-cf` depends on published `@skyphusion-labs/vivijure-core`, implements
`src/platform/` (`cfPlatformFromEnv`), and imports orchestration from the package (no duplicate
module registry / film-orchestrator / types under host `src/modules/`). Phases A--D below are the
migration record, not a backlog.

### Phase A -- dependency + adapter (no behavior change) -- done

1. Add to `package.json`:
   ```json
   "@skyphusion-labs/vivijure-core": "file:../vivijure-core"
   ```
   (or published semver once on GitHub npm)

2. Add `src/platform/cf-platform.ts`:
   ```typescript
   import type { Platform, ObjectPresigner, ModuleTransport } from "@skyphusion-labs/vivijure-core/platform";
   import type { Env } from "../env.js";

   export function cfPlatformFromEnv(env: Env): Platform {
     return {
       db: env.DB,
       renders: env.R2_RENDERS,      // already R2Bucket; wrap if needed
       chatBucket: env.R2,
       presigner: cfPresignerFromEnv(env),
       secrets: cfSecretStoreFromEnv(env),
       modules: cfModuleTransportFromEnv(env),
       rateLimiter: env.SPEND_RATE_LIMITER ?? undefined,
       vars: pickOrchestratorVars(env),
       hostBindings: pickHostBindings(env),  // VIDEO_FINISH_VPC, etc.
     };
   }
   ```

3. Wire `cfPresignerFromEnv` to existing `src/r2-presign.ts` (SigV4 stays in host).

4. Wire `cfModuleTransportFromEnv` to existing `MODULE_*` service binding resolution in registry.

5. Add a contract test: `cfPlatformFromEnv(mockEnv)` satisfies `Platform` shape.

### Phase B -- swap imports (wave order matches extraction) -- done

For each file group, change host `src/foo.ts` from implementation to:

```typescript
export * from "@skyphusion-labs/vivijure-core/foo";
```

Or delete `src/foo.ts` and update call sites to import core directly.

Recommended order (matches extraction waves in `EXTRACTION-STATUS.md`):

1. Pure: `preflight`, `planner-prompt`, `output-extract`, `public-id`, `tar`, `captions`, `srt`
2. Module: `modules/types.ts` (delete; import from core), `conformance`, `registry`, `render-pipeline`
3. Models: `film-model`, `clip-job-model`, `storyboard-validate`, `storyboard-ids`
4. Orchestrators: `render-orchestrator`, `film-orchestrator`, `film-render-bridge`
5. DB: `cast-db`, `storyboard-projects-db`, `renders-db`, `render-log`
6. Bundle: `bundle-assembler`, `bundle-durations`, `planner-yaml`, `key-safety`

After each wave: `npm run typecheck`, worker tests, no duplicate file left in host `src/`.

### Phase C -- route handlers use Platform -- done

Historical target (now landed):

```typescript
import { orchestratorContextFromPlatform } from "@skyphusion-labs/vivijure-core/platform";
import { advanceFilm } from "@skyphusion-labs/vivijure-core/film-orchestrator";

const platform = cfPlatformFromEnv(env);
const orchEnv = orchestratorContextFromPlatform(platform);
await advanceFilm(orchEnv, ...);
```

`env.ts` stays for Worker entry, wrangler types, and bindings the ICD does not model (AI, ASSETS,
ACCESS). Only orchestration paths go through `Platform`.

### Phase D -- release -- done

1. Duplicated orchestration removed from the CF host `src/` (imports from package).
2. Module contract lives canonically in `vivijure-core`; module workers vendor shapes they need
   (no inbound sync -- core is the source of truth for `vivijure-module/2`).
3. Published on npm as `@skyphusion-labs/vivijure-core` (current line: see package.json /
   `RELEASES.md`; hosts pin semver ranges, not a single frozen major).

### What stays in the CF host

- `index.ts` (fetch router, `scheduled()`, Assets)
- `env.ts`, `access-auth.ts`, `auth-gate.ts`
- `ai-binding.ts`, `planner.ts`, `providers/*`, `parsers/*`
- Host transport / wrangler wiring (presign, installed-modules discovery, CF bindings)
- Studio MCP: [`@skyphusion-labs/vivijure-mcp`](https://github.com/skyphusion-labs/vivijure-mcp)
  (separate npm package; not in core)

---

## Parity checks (both hosts)

| Check | Command / location |
|-------|-------------------|
| Module contract | `@skyphusion-labs/vivijure-core` `modules/types` (hosts import; no host copy) |
| Platform ICD version | `PLATFORM_ICD_VERSION` in core + contract tests |
| HTTP CONTRACT | `vivijure-cf` canon `docs/CONTRACT.md`; local `docs/PARITY.md` |
| Conformance harness | `npm test` in `vivijure-core`; live sidecars in `vivijure-local` |

---

## Publishing (live)

1. Publish `@skyphusion-labs/vivijure-core` to npm on `vivijure-core-v*` tags (see README /
   `RELEASES.md`).
2. Hosts depend on published semver (`^1.x`); optional `file:../vivijure-core` for local monorepo
   work only.
3. CI checks out published tarball or uses `npm ci` with lockfile pin; Docker uses multi-stage
   `npm ci` without sibling clone.

Local sibling `file:` deps remain valid for Conrad's laptop + rancid dev layout.
