# Parity contract -- vivijure-core vs vivijure

**Canonical source:** `skyphusion-labs/vivijure` `src/` on `main` (CF-native control plane).

**Consumer:** `@skyphusion-labs/vivijure-core` must match vivijure **behavior** on every extracted file. Platform refactors (`Env` → `OrchestratorEnv`, `presign.ts`, split helpers) are allowed only when the wire behavior and public API semantics are unchanged.

**Module contract:** `src/modules/types.ts` must stay **byte-identical** to `vivijure/src/modules/types.ts`. Sync: `npm run sync:module-types`.

**Verify locally:**

```bash
npm run parity:vivijure          # behavioral file list + modules/types.ts
npm run parity:vivijure:strict   # + fail on any differing shared file (import-only drift)
```

Baseline commit when this doc was written: vivijure `de000f7` (v0.21.2).

---

## What "full parity" means

| Layer | Rule |
|-------|------|
| Pure helpers | Same logic as vivijure (preflight, planner-prompt, public-id, tar-emit, etc.) |
| Orchestrators | Same state machine, retry contracts, error strings, R2 key conventions |
| DB helpers | Same SQL and row shapes (`DbEnv` instead of `Env` is OK) |
| Platform ICD | Core-only; vivijure adopts via `cfPlatformFromEnv()` later |
| Host routes | Stay in vivijure / vivijure-local (never in core) |

**Not in scope for byte parity:** `index.ts`, `env.ts`, auth, AI providers, cast-media HTTP routes, demo, MCP.

**tar note:** core `tar.ts` ≡ vivijure `tar-emit.ts` (storyboard bundles). Vivijure `tar.ts` (cast `.vvcast`) stays host-only.

---

## Sprint status (`feat/vivijure-parity-p0`)

### P0 -- behavioral drift

| ID | Area | Status |
|----|------|--------|
| P0-1..5 | bundle-assembler, render-orchestrator, film-orchestrator, quality_tier | **done** |
| P0-6 | `render-log` GATEWAY_ID via `secretValue` | **done** |
| P0-7 | `modules/registry` discovery cache (matches vivijure) | **done** |

### P1 -- contract tests ported from vivijure

`bundle-key-collision`, `render-orchestrator`, `quality-tier-drift`, `film-advance-lease`, `dialogue-lines`, `scatter`, `runpod-wire-contract`, `d1-retry`, `render-log`, `operator-config` -- **done** (175 tests green).

### P2 -- shared files (import/platform drift expected)

Run `npm run parity:vivijure` for the live diff list. Remaining diffs are mostly:

- `import type { Env } from "./platform/orchestrator-context.js"` vs `./env`
- `./presign.js` vs `./r2-presign`
- `./storyboard-ids.js` vs `./storyboard-validate` for `coerceShotId`
- `emitStructuredEvent` in `d1-retry` (stdout-equivalent to vivijure `console.log(JSON)`)

### P3 -- extracted into core

| Module | Notes |
|--------|-------|
| `secret-store.ts` | Secrets Store binding resolver |
| `voices.ts`, `dialogue-lines.ts` | Dialogue batch for render |
| `bundle-storyboard.ts` | Read `storyboard.yaml` from bundle tar |
| `scatter.ts`, `scatter-orchestrator-types.ts`, `scatter-orchestrator.ts`, `scatter-notify.ts` | Scatter/gather conductor |
| `lora-bundle.ts`, `cast-loras.ts`, `cast-lora-train.ts` | Cast LoRA resolution + training |
| `runpod-submit.ts` | Full submit/poll (types re-exported via `runpod-types.ts`) |
| `beat-analyze.ts` | Planner beat analysis |
| `render-sweep.ts`, `render-adopt.ts`, `render-mux.ts` | Background sweep + adopt/mux |

**Still host-only:** `cast-media` routes, `index.ts` HTTP handlers, auth, AI providers, demo, MCP.

Port helper: `bash scripts/port-from-vivijure.sh` (after vivijure `main` changes).

---

## CI gates (target)

1. `npm run parity:vivijure` on every PR (sibling `../vivijure` clone)
2. `npm run sync:module-types` + diff check in CI
3. Core test suite includes all ported contract tests from vivijure

---

## Change control

1. Fix vivijure upstream first when the contract changes on `main`.
2. Port into core in the same PR wave (or immediately after merge).
3. Never "fix forward" only in core without a matching vivijure change unless the CF host has not adopted core yet AND the change is core-only infrastructure (`structured-events`, platform ICD).
