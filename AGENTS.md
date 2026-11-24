# Vivijure Core

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

This package is shared orchestration for Vivijure Studio. It holds the module registry, the film and clip pipeline, planner helpers, and the platform ICD. The npm name is `@skyphusion-labs/vivijure-core`.

Both hosts consume the published package.

| Host | Repo | Runtime |
|------|------|---------|
| Cloudflare | `vivijure-cf` | Workers, D1, R2, service bindings |
| Local | `vivijure-local` | Node, SQLite, S3 or MinIO, HTTP sidecars |

HTTP routes are specified in vivijure-cf [docs/CONTRACT.md](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/CONTRACT.md). Local gaps are in vivijure-local `docs/PARITY.md`.

The module wire contract lives in this package. `src/modules/types.ts` is `vivijure-module/2` on npm. The planner boundary is [docs/CORE-VS-MODULES.md](docs/CORE-VS-MODULES.md). Adoption history is [docs/HOST-ADOPTION.md](docs/HOST-ADOPTION.md).

See root `package.json`, the latest `vivijure-core-v*` tag, [RELEASES.md](RELEASES.md), and [CHANGELOG.md](CHANGELOG.md). Do not freeze a number here.

## Rules

Core never imports host env. No `./env`. No `@cloudflare/workers-types`. No `process.env` reads. Orchestration uses `Platform`, `DbEnv`, or `OrchestratorEnv` from `@skyphusion-labs/vivijure-core/platform`.

This repo is the canonical `vivijure-module/2` contract. Hosts and module workers take types from the published package. Do not sync types in from a host `src/modules/*` tree. Bump the epoch only with a release of every consumer.

`src/platform/types.ts` is the frozen adapter contract (`PLATFORM_ICD_VERSION`). Bump the version, [docs/PLATFORM.md](docs/PLATFORM.md), and the contract tests before a host ships a release that needs the new shape.

Hosts should import a subpath, such as `@skyphusion-labs/vivijure-core/film-orchestrator`. Do not reach deep into `node_modules` with a relative path.

This package is not a Worker. It has no HTTP router and no auth gate. Hosts wire the platform and the routes. Demo mode is a host concern.

## Commands

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
```

`npm run typecheck` is the CI gate. Run it before you push. The pull request flow is [CONTRIBUTING.md](CONTRIBUTING.md).

## Release

Full ledger: [RELEASES.md](RELEASES.md). Publish goes to npm through `.github/workflows/publish-npm.yml`.

A version moves only in a release pull request. Bump the version, then update the ledger. A feature pull request does not bump. A fix pull request does not bump.

The version of record is `package.json` (and the lockfile). The tag shape is `vivijure-core-v*` only. A bare `v*` tag does not publish.

Before a release pull request, check tags. If the current manifest version already has a tag, the cycle is closed, so the release pull request bumps. If it has no tag, stop. Read why before you bump again.

Order:

1. Release this package first.
2. Then bump the pin in `vivijure-cf` and `vivijure-local`. Pins may lag between waves. User-facing work still ships on both panels.
3. A caret pin can pick up a MINOR on the next install. A host release is still required to deploy the studio. An epoch bump needs every consumer.

Cut a release:

1. Open a release pull request on `main`. Bump `package.json`. Update the [RELEASES.md](RELEASES.md) row. Leave the source commit and the publish date empty until after publish.
2. An org admin tags that pull request merge commit. The tag must match `package.json`.

```bash
git fetch origin main --tags
sha="$(gh pr view <release-pr> --json mergeCommit -q .mergeCommit.oid)"
git tag vivijure-core-vX.Y.Z "$sha"
git push origin vivijure-core-vX.Y.Z
```

3. npm CI does not create the GitHub Release. Create it:

```bash
gh release create vivijure-core-vX.Y.Z --title "vivijure-core vX.Y.Z" --notes-file notes.md
```

4. Confirm `publish-npm.yml` is green. Confirm `npm view @skyphusion-labs/vivijure-core@X.Y.Z version`.
5. Close the ledger row in a follow-up (source commit and registry date).

A merge to `main` does not publish. Verify the npm artifact.

SemVer: PATCH for fixes, MINOR for features. See `package.json` for the current version.

## Docs and safety

Write Simplified Technical English. Use short sentences. Put one idea in each sentence. Use the active present tense. Use plain words. Use the same word every time.

Do not use an em dash (U+2014). Do not use an en dash (U+2013). Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability. Do not turn a measured result into a promise.

The CSAM ban includes synthetic images. Hosts enforce it. Core must not weaken it.

Do not put a secret in a tracked file. Do not freeze an endpoint id in this file.
