# CLAUDE.md -- vivijure-core

## What this is

**Shared orchestration** for Vivijure Studio: module registry, film/clip pipeline, planner helpers,
platform ICD. Published as **`@skyphusion-labs/vivijure-core`**.

**HOST-ADOPTION is COMPLETE.** Both thin hosts consume the published package:

| Host | Repo | Runtime |
|------|------|---------|
| CF-native | `skyphusion-labs/vivijure-cf` | Workers, D1, R2, service bindings |
| Local | `skyphusion-labs/vivijure-local` | Node, SQLite, S3/MinIO, HTTP sidecars |

Wire contract for HTTP routes is `vivijure-cf` `docs/CONTRACT.md`; `vivijure-local` tracks gaps in
`docs/PARITY.md`. **Module wire contract SoT is this
package** (`src/modules/types.ts` here = `vivijure-module/2` on npm). **Planner vs module boundary:**
[docs/CORE-VS-MODULES.md](docs/CORE-VS-MODULES.md). Adoption history: [docs/HOST-ADOPTION.md](docs/HOST-ADOPTION.md).

Version: see root `package.json` / latest `vivijure-core-v*` tag / `RELEASES.md` / `CHANGELOG.md`.

## Rules

- **Core never imports host env.** No `./env`, no `@cloudflare/workers-types`, no `process.env` reads.
  Orchestration uses `Platform`, `DbEnv`, or `OrchestratorEnv` from
  `@skyphusion-labs/vivijure-core/platform`.
- **Module contract is sacred.** This repo is the **canonical** `vivijure-module/2` contract; hosts
  and module workers take types **from here** (published package). No inbound sync from host
  `src/modules/*` after extraction. Bump the epoch only with a coordinated release across every
  consumer.
- **Platform ICD:** `src/platform/types.ts` is the frozen adapter contract (`PLATFORM_ICD_VERSION`).
  Bump version + `docs/PLATFORM.md` + contract tests before either host ships a release that depends
  on the new shape.
- **Subpath imports for hosts.** Prefer `@skyphusion-labs/vivijure-core/film-orchestrator` over deep
  relative paths into `node_modules`.
- **No HTTP routers here.** This package is not a Worker: no request routing or auth gates. Orchestration (scatter, film, RunPod submit helpers, module contracts) lives here; hosts wire platform + routes and adopt via npm. Demo mode is a host concern.
- **Ignore Cursor `AGENTS.md`** if present.

## Commands

```bash
npm run typecheck   # tsc --noEmit (+ tests tsconfig) -- CI gate; run before push
npm test
npm run test:coverage
npm run build
```

## Release / tagging

SemVer on the **1.x** line (`1.MINOR.PATCH`). Full ledger + checklist: **`RELEASES.md`**.

Publish target: npm `@skyphusion-labs/vivijure-core` via `.github/workflows/publish-npm.yml`.

### Order (hosts depend on this package)

1. **Release `vivijure-core` first** (this repo).
2. Then bump the pin in **`vivijure-cf`** and **`vivijure-local`** and tag those hosts (pins may lag
   each other between waves; product dual-panel still required for user-facing work).
3. A caret pin (`^1.x`) can pick up a MINOR on next install, but a deliberate host release is still
   required to deploy the studio / publish GHCR images. A `vivijure-module/N` epoch bump requires a
   coordinated release across every consumer.

### Cut a release

1. **Release PR on `main`:** bump `package.json` `version`, update `RELEASES.md` ledger row (seed
   tag + notes; leave source commit / published empty until after publish), land the PR.
2. **Tag the release PR's merge commit** (must match `package.json` exactly; the workflow refuses
   a mismatch). Only an org admin (the lead or Conrad) can create a release tag; crew open the
   release PR and ask the lead to tag:

```bash
git fetch origin main --tags
sha="$(gh pr view <release-pr> --json mergeCommit -q .mergeCommit.oid)"
git tag vivijure-core-vX.Y.Z "$sha"
git push origin vivijure-core-vX.Y.Z
```

3. **GitHub Release** (npm CI does **not** create this):

```bash
gh release create vivijure-core-vX.Y.Z --title "vivijure-core vX.Y.Z" --notes-file notes.md
```

4. Confirm `publish-npm.yml` green and `npm view @skyphusion-labs/vivijure-core@X.Y.Z version`.
5. Close the `RELEASES.md` ledger row (`source commit` + registry published date).

Tag pattern is **`vivijure-core-v*`** only (not bare `v*`). Merge to `main` alone does **not** publish.
Verify the **npm artifact**, not only the pipeline.

## Hard rules

- **CSAM bright-line (NON-NEGOTIABLE):** zero tolerance including synthetic (hosts enforce; core must
  not weaken).
- **Typecheck is the CI gate.**
- **No em-dashes / en-dashes.** Use `--` or commas.
- **Never freeze open sprint boards or specific RunPod endpoint IDs.**

## Crew + identity

Crew members work as their own Unix + gh identity (`sudo -u <member> bash -lc '...'`). Crew commits
use `skyphusion-<member>` identity, never Conrad's. Conrad devs only on his laptop
(`Conrad Rockenhaus <conrad@skyphusion.org>`).

## Release convention (bump-at-release)

One convention for every skyphusion-labs repo (Conrad, ruled 2026-11-10, fleet-chezmoi#1766). A version moves ONLY in a release PR: bump the version, then assemble the changelog. Feature and fix PRs do not bump. Releases go through a PR (fleet-chezmoi#1622) and the tag goes on that PR's merge commit. This repo used to be open-once; `RELEASES.md` records the change; the changelog guards match it (core#550).

- Version of record here: package.json (and package-lock.json).
- Tag shape: `vivijure-core-v*`.
- Check before a release PR: does a tag already exist for the version currently in the manifest? Yes means the cycle is closed, so the release PR bumps. No means a bump already landed outside a release PR; stop and read why before bumping again.
