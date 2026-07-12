# Host adoption -- vivijure-core

Checklist for wiring **vivijure** (Cloudflare) and **vivijure-local** (Node) onto
`@skyphusion-labs/vivijure-core` with minimal churn.

## vivijure-local (Node) -- done / in progress

| Step | Status |
|------|--------|
| Depend on `@skyphusion-labs/vivijure-core` (`file:../vivijure-core`) | done |
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

## vivijure (Cloudflare) -- planned

The CF host still carries duplicate orchestration under `src/`. Adoption is **incremental**: add the
dependency, introduce a Platform adapter, swap imports file-by-file, delete duplicates in the same PR.

### Phase A -- dependency + adapter (no behavior change)

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

### Phase B -- swap imports (wave order matches extraction)

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

### Phase C -- route handlers use Platform

Today CF routes pass `env: Env` directly into orchestrators. Target:

```typescript
import { orchestratorContextFromPlatform } from "@skyphusion-labs/vivijure-core/platform";
import { advanceFilm } from "@skyphusion-labs/vivijure-core/film-orchestrator";

const platform = cfPlatformFromEnv(env);
const orchEnv = orchestratorContextFromPlatform(platform);
await advanceFilm(orchEnv, ...);
```

`env.ts` stays for Worker entry, wrangler types, and bindings the ICD does not model (AI, ASSETS,
ACCESS). Only orchestration paths go through `Platform`.

### Phase D -- release

1. Delete all duplicated orchestration files from `vivijure/src/`.
2. Bump `vivijure` to `2.0.0` with `vivijure-core@^1.0.0`.
3. Lock `modules/types.ts` sync: `vivijure-core` `npm run sync:module-types` in CI when upstream
   contract changes.

### What never moves to core (CF host keeps)

- `index.ts` (fetch router, `scheduled()`, Assets)
- `env.ts`, `access-auth.ts`, `auth-gate.ts`
- `ai-binding.ts`, `planner.ts`, `providers/*`, `parsers/*`
- `runpod-submit.ts` (HTTP to RunPod)
- `scatter-orchestrator.ts` (candidate for core Phase 4; not yet extracted)
- `demo-render.ts`, `demo-chat.ts`, `mcp*.ts`
- `r2-presign.ts` (implementation; core only calls `PRESIGNER` interface)
- `installed-modules.ts` (CF dispatch discovery wrapper)

---

## Parity checks (both hosts)

| Check | Command / location |
|-------|-------------------|
| Module contract byte match | `diff vivijure/src/modules/types.ts vivijure-core/src/modules/types.ts` |
| Platform ICD version | `PLATFORM_ICD_VERSION` in core + contract tests |
| HTTP CONTRACT | `vivijure` canon `docs/CONTRACT.md`; local `docs/PARITY.md` |
| Conformance harness | `npm test` in `vivijure-core`; live sidecars in `vivijure-local` |

---

## Publishing (when ready)

1. Publish `@skyphusion-labs/vivijure-core` to GitHub npm registry.
2. Replace `file:../vivijure-core` with `"^0.8.0"` (then `^1.0.0` at v2.0).
3. CI checks out published tarball or uses `npm ci` with lockfile pin; Docker uses multi-stage
   `npm ci` without sibling clone.

Local sibling `file:` deps remain valid for Conrad's laptop + rancid dev layout.
