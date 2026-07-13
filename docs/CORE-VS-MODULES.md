# Core vs modules -- Vivijure Studio control plane

The Vivijure control plane is **not** a bag of hardcoded AI and render backends. It is two things
that are always present:

1. **Planner scaffold** -- prompt assembly, validation, and dispatch (no provider opinions).
2. **Module host** -- discover installed modules, clamp config, invoke hooks, fold chain outputs.

Everything an operator can swap (which LLM plans storyboards, which TTS speaks dialogue, which email
sends notify, which GPU renders keyframes) lives in **installed modules**, not in core source.

This doc is the canonical boundary for `@skyphusion-labs/vivijure-core` and the thin hosts that
consume it (`vivijure-local`, and eventually `vivijure` after host adoption). It does **not** change
the HTTP wire contract in upstream `vivijure/docs/CONTRACT.md`; it explains **who owns which logic**.

## Layer picture

```
+------------------------------------------------------------------+
|  HTTP routes, auth, static UI, platform adapter                   |  HOST (thin)
|  planner.ts: assemble prompt -> invokeModule -> validate         |
+------------------------------------------------------------------+
|  @skyphusion-labs/vivijure-core                                  |  THIS PACKAGE
|  planner-prompt, storyboard-validate, preflight, registry,       |
|  film-orchestrator, conformance, bundle/tar, *-db                |
+------------------------------------------------------------------+
|  Module workers (vivijure-module/2 hooks)                        |  SWAPPABLE
|  plan.enhance, cast.image, dialogue, speech, notify, keyframe, … |
+------------------------------------------------------------------+
```

The scaffold is **not** an empty shell. Core always ships the prompts, structural validation,
orchestration state machines, and module ICD that every studio needs regardless of which modules are
installed.

## Core scaffolding (always present)

| Responsibility | Where | Notes |
|----------------|-------|-------|
| Hook contract + cardinality | `src/modules/types.ts` | `HookName`, `HOOK_CARDINALITY`, per-hook I/O types |
| Module discovery + invoke | `src/modules/registry.ts` | `discoverModules`, `invokeModule`, `dispatchChain` |
| Manifest + output conformance | `src/modules/conformance.ts` | Reject bad modules before they reach orchestration |
| Planner prompt text + fence cleanup | `src/planner-prompt.ts` | Pure strings; no network |
| Storyboard structural validation | `src/storyboard-validate.ts` | Sync, no I/O |
| Pre-render preflight | `src/preflight.ts` | Cast bindings, module availability checks |
| Storyboard YAML parse/serialize | `src/planner-yaml.ts` | Bundle interchange |
| Film + clip orchestration | `src/film-orchestrator.ts`, `render-orchestrator.ts` | Calls modules at hook points |
| Render hook selection | `src/modules/render-pipeline.ts` | `pick_one` vs `chain` resolution |
| Registry projection for UI | `src/modules/registry.ts` + `HOOK_BLURBS` | Host serves `GET /api/modules` from this |
| Config clamping | registry + `config_schema` | User/render/install scopes from manifest |

**Host planner scaffold** (stays in each host repo, stays thin):

- Build `PlanEnhanceInput` (or other hook inputs) from HTTP bodies + `planner-prompt` helpers.
- Resolve which installed module answers (`servingForHook`, operator binding env vars).
- `invokeModule` / `dispatchChain`; never import Anthropic/OpenAI/Gemini clients in the planner.
- Run `storyboard-validate` on module output before returning JSON.
- Derive `GET /api/storyboard/models` from installed `plan.enhance` modules' `config_schema` (not a
  hardcoded catalog in core or host).

## Module-provided (swappable)

Modules declare hooks in their manifest and implement a single `POST /invoke` entry. The core does not
branch on module names; it branches on **hook names** only.

| Hook | Cardinality | Typical capability |
|------|-------------|-------------------|
| `plan.enhance` | chain | Planning LLM (plan / refine / enhance / chat), auto-direction |
| `cast.image` | pick one | Portrait + bible -> training reference images |
| `dialogue` | pick one | Spoken lines -> per-character TTS |
| `speech` | chain | Dialogue audio cleanup / upscale |
| `notify` | chain | Render-complete email / webhook |
| `keyframe` | pick one | Storyboard -> start keyframes |
| `motion.backend` | pick one | Keyframe -> shot clip |
| `finish` | chain | Per-clip post (upscale, interpolate, face restore) |
| `score` | chain | Music / narration / beat-sync |
| `master` | chain | Film-level audio mastering |
| `film.finish` | chain | Title / credit cards |

### `plan.enhance` owns planning AI

One module family serves every LLM-facing planner surface:

| Surface | HTTP route (host) | Module config |
|---------|-------------------|---------------|
| Brief -> storyboard | `POST /api/storyboard/plan` | `mode: plan` (+ `model`, etc. from `config_schema`) |
| Edit existing board | `POST /api/storyboard/refine` | `mode: refine` |
| Shot auto-direction | `POST /api/storyboard/enhance` | `mode: enhance` (or default chain behavior) |
| Planner chat (text) | `POST /api/chat` | `mode: chat` |
| Model picker catalog | `GET /api/storyboard/models` | Enum fields on installed `plan.enhance` manifests |

To run local Llama instead of cloud Opus, install a different `plan.enhance` module (or point the
host binding at a sidecar that uses `ENHANCE_MODEL` / Workers AI). **No planner code change.**

Example host bindings (local sidecars; CF uses service bindings with the same names):

| Env / binding | Hook |
|---------------|------|
| `MODULE_PLANENHANCE` | `plan.enhance` |
| `MODULE_CAST_IMAGE` | `cast.image` |
| `MODULE_DIALOGUE` | `dialogue` |
| `MODULE_SPEECH_UPSCALE` | `speech` |
| `MODULE_NOTIFY_EMAIL` | `notify` |

## What must not live in the planner

These are **module concerns**, not scaffold concerns:

- LLM provider clients (Anthropic, OpenAI, Gemini, Workers AI, local Ollama, etc.)
- Hardcoded `PLANNING_MODELS` / model enum lists in host source
- Image generation for cast portraits (`cast.image`)
- Voice catalogs and TTS (`dialogue`; voice list should come from module metadata when exposed)
- Email / webhook delivery (`notify`)
- GPU / RunPod / cloud render execution (render hooks + host submit adapters)

The host may still own **transport** (AI Gateway headers, RunPod API keys) inside module workers or
sidecars, not in `planner.ts`.

## Render path (already module-first)

Film and scatter orchestration in core already dispatch `keyframe`, `motion.backend`, `finish`,
`score`, `master`, `film.finish`, `dialogue`, and `speech` through the registry. Planning was the
main gap; the scaffold + `plan.enhance` split above brings planning in line with render.

## Adoption status (informational)

| Host | Planner scaffold | Notes |
|------|------------------|-------|
| `vivijure-local` | Module-driven `plan.enhance` | Reference implementation for this doc |
| `vivijure-cf` (CF) | Partial | `/api/storyboard/enhance` uses modules; plan/refine/chat and models catalog still call core providers in host `planner.ts` until host adoption catches up |

Track host migration in [HOST-ADOPTION.md](HOST-ADOPTION.md). **Do not fork module logic back into
core** to paper over a host that has not adopted the scaffold yet.

## Related docs

- [ARCHITECTURE.md](ARCHITECTURE.md) -- package vs host split, import rules
- [PLATFORM.md](PLATFORM.md) -- `Platform` ICD for DB/storage/module fetchers
- `src/modules/types.ts` -- `vivijure-module/2` wire shapes (synced with upstream module workers)
- Upstream HTTP contract: `vivijure/docs/CONTRACT.md` (route names and JSON shapes)
