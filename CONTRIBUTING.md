# Contributing

## Changelog entries: fragment files, preferred over editing CHANGELOG.md directly (core#202)

Add a file under changelog.d/, rather than editing CHANGELOG.md, whenever more than one PR is
open against this repo. core#202 measured core#195 re-resolved on CHANGELOG.md FOUR times with its
own content never changing, because every sibling PR that merged moved the single shared heading
main was appending under. Two PRs adding two different fragment files never touch the same file,
so the conflict class disappears rather than being resolved repeatedly.

core#212 measured a second, worse failure of the shared-heading shape: a PR branched before the
open cycle heading closed lands its diff INSIDE the section that heading became, with a clean
merge every time and nothing signalling it. A fragment file carries no heading reference at all,
so this cannot happen to a PR that uses one.

Ported from the convention vivijure-control-plane built first (cp#358) and vivijure-cf ported
second (cf#546), unchanged where the two repo shapes agree.

Filename: `<issue>-<short-slug>.md` (for example `202-fragment-convention.md`), issue number first
so a directory listing sorts by issue. No issue number: `pr<N>-<slug>.md`.

Content: exactly the `###` block that would have gone under the open Unreleased-shaped heading
today. No new syntax, no front matter, no type taxonomy -- move the same prose to a different file.

`scripts/changelog-entry-required.mjs` accepts EITHER form during the migration window: a
changelog.d/ fragment or a direct CHANGELOG.md edit. Fragments are preferred for every new PR; a
direct edit still passes the guard, so a currently open PR is not broken by this change landing.
The guard applies to PRs touching `src/`.

## Closing a cycle at release time

At release time, run `node scripts/changelog-assemble.mjs <version> <date>` to fold every
changelog.d/ fragment (plus whatever is still sitting under the currently open Unreleased-shaped
heading) into the released section, in place of hand-editing that heading. This replaces the
changelog half of step 1 in "Cutting a release" in RELEASES.md. The version is always an explicit
argument, never inferred from the current top heading (core#202, following cf#542 in
vivijure-cf). Refuses loudly and writes nothing if that version already appears as a heading
anywhere in CHANGELOG.md, so re-running it for an already-promoted version cannot duplicate one.

Unlike vivijure-cf, this script does not leave a permanent empty Unreleased heading behind. See
the top-of-file comment in scripts/changelog-assemble.mjs: RELEASES.md documents main sitting on a
tagged version with no open Unreleased heading as the deliberate steady state between releases
(core#146), and a permanent anchor would fire the tests/changelog-version.test.ts spent-version
guard on every release cut, before the next feature PR bumps package.json.

## Before closing a cycle: check who is still open

core#212 own live measurement: the trigger for the misfiling class is the RELEASE CUT itself, not
branch age. A PR is exposed the instant a release is cut while it is open, no matter how recently
it was branched, because the entry it wrote genuinely was under the open heading at PR time and
only becomes wrong once main advances past it. A PR-time gate cannot see this: it is structurally
incapable of failing on the input it is meant to catch, because the defect is created AFTER the PR
is reviewed.

So run `node scripts/changelog-release-cut-check.mjs` before running changelog-assemble.mjs. It
refuses if any open PR still touches CHANGELOG.md directly, naming each one, since closing the
heading now would strand its entry under the newly published section once it merges. A PR that
used a changelog.d/ fragment instead is not at risk, by construction. See RELEASES.md.

## The gate

`npm run typecheck` and `npm test` run in CI on every PR (`.github/workflows/ci.yml`).
`.github/workflows/changelog.yml` is the changelog entry gate described above.
