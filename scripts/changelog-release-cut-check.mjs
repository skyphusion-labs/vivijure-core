#!/usr/bin/env node
// A release-prep gate, run BEFORE closing the currently open heading (core#212).
//
// core#212 own live measurement (the lead, cutting v1.15.0): the trigger is the RELEASE CUT, not
// branch age. A PR is exposed the instant a release is cut while it is open, regardless of how
// recently it was branched -- a PR opened the same night misfiles identically to one opened a week
// earlier. Measured live: 4 of 5 open core PRs (#199, #203, #207, #219) carried an entry under
// ## Unreleased / v1.15.0; closing that heading with any of them still open converts each into the
// exact core#212 shape -- branched before a heading that has since closed, merging cleanly into a
// PUBLISHED section, nothing warning.
//
// WHY A PR-TIME GATE CANNOT CATCH THIS. scripts/changelog-entry-required.mjs runs at PR time, when
// the entry genuinely IS under the open heading -- it passes, correctly. The defect is created
// AFTERWARDS, by an event on main the PR never observes. A guard that only runs at PR time is
// structurally incapable of seeing this, which is the family this whole loop is about: a check
// that cannot fail on the input it exists to catch.
//
// THE FIX: a second check, run at the OTHER end -- at release-cut time, before the heading closes,
// against the population that is knowable exactly then: open PRs touching CHANGELOG.md directly.
// A PR using a changelog.d/ fragment instead is NOT at risk (core#202/core#212): a fragment carries
// no heading reference, so a cut cannot strand it. That is the durable fix; this script is the
// belt, for the migration window where a direct CHANGELOG.md edit is still accepted.
//
// SCOPE: refuses on ANY open PR touching CHANGELOG.md, without trying to determine whether that
// particular PR entry would actually land in the wrong place. A false refusal here costs waiting
// for PRs to land or asking an author to switch to a fragment; a false pass costs a published
// release note that is wrong, which core#212 measured as expensive and silent. Asymmetric costs,
// so this errs conservative on purpose.
import { execFileSync } from "node:child_process";

export function classifyPr(files) {
  return { touchesChangelogDirect: files.includes("CHANGELOG.md") };
}

/** Pure: prList is [{ number, files: string[] }, ...]. Testable with no repository or network. */
export function checkOpenPrs(prList) {
  const atRisk = prList
    .filter((pr) => classifyPr(pr.files).touchesChangelogDirect)
    .map((pr) => pr.number)
    .sort((a, b) => a - b);
  return { ok: atRisk.length === 0, atRisk };
}

function fetchOpenPrFiles(repo) {
  const raw = execFileSync(
    "gh",
    ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,files", "--limit", "100"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(raw);
  return parsed.map((pr) => ({
    number: pr.number,
    files: pr.files.map((f) => f.path),
  }));
}

function main(argv) {
  const repo = argv[2] || "skyphusion-labs/vivijure-core";
  const prs = fetchOpenPrFiles(repo);
  console.log("Open PRs examined: " + prs.length);
  const result = checkOpenPrs(prs);
  if (!result.ok) {
    console.log(
      "::error::Open PRs touching CHANGELOG.md directly: #" + result.atRisk.join(", #") +
      ". Closing the currently open heading now will strand their entries under it once they " +
      "merge (core#212). Wait for them to land, or ask their authors to move the entry to a " +
      "changelog.d/ fragment first.",
    );
    return 1;
  }
  console.log("OK: no open PR touches CHANGELOG.md directly. Safe to close the heading.");
  return 0;
}

if (import.meta.url === "file://" + process.argv[1]) {
  process.exit(main(process.argv));
}
