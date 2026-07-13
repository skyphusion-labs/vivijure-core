# Parity contract -- vivijure-core

> **The core <-> monolith byte-parity sprint is DONE and its CI gate is RETIRED.** Extraction is
> complete: `vivijure-cf` adopted the published `@skyphusion-labs/vivijure-core` and carries no
> duplicate orchestration `src/`, so there is nothing to hold byte-parity *against* anymore. The old
> `parity-vivijure` workflow, the `parity:vivijure` / `parity:vivijure:strict` scripts, and
> `scripts/port-from-vivijure.sh` were removed in vivijure-core #44. This doc is kept as the record of
> what parity meant during extraction.

## What parity means now

`vivijure-core` is the **single source of truth** for the orchestration layer and the module contract
(`src/modules/types.ts`, `vivijure-module/2`). Consumers depend on the published package; nothing
syncs *into* core.

| Consumer | How it stays aligned |
|----------|----------------------|
| `vivijure-cf` | Pins a published `@skyphusion-labs/vivijure-core` version; bump the pin to adopt a change. |
| `vivijure-local` | Consumes the published package via semver (`file:../vivijure-core` for local dev). |
| Module workers | Vendor `modules/types.ts` from core; the module conformance suites enforce the contract. |

The **only** ongoing parity check in the constellation is **`vivijure-local` <-> `vivijure-cf` on the
shared `public/` planner UI**, enforced by vivijure-local's `upstream-parity` workflow (which diffs
against `vivijure-cf`, not this repo).

## Change control

1. Land the orchestration or contract change here, in `vivijure-core`.
2. Publish a new `@skyphusion-labs/vivijure-core` version.
3. Bump the pin in `vivijure-cf` (and `vivijure-local` as needed) to adopt it.
4. Bump `PLATFORM_ICD_VERSION` + `docs/PLATFORM.md` + the platform contract tests for any adapter
   shape change before a host ships against it.

## Historical record -- the extraction sprint

The orchestration layer was extracted wave-by-wave from the (now retired) `skyphusion-labs/vivijure`
monolith; see [EXTRACTION-STATUS.md](EXTRACTION-STATUS.md) for the file inventory. During that sprint a
`parity-vivijure` gate diffed core against the monolith's `src/` to prove behavioral equivalence
(bundle-assembler, render/film orchestrators, quality-tier drift, advance-lease, dialogue, scatter,
RunPod wire contract, D1 retry, render-log). That gate served its purpose and was retired once
`vivijure-cf` adopted the package.
