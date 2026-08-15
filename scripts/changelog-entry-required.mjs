#!/usr/bin/env node
// A PR touching src/ needs a CHANGELOG.md entry of its own (core#178), or a changelog.d/ fragment
// (core#202, ported from vivijure-cf#546, itself ported from vivijure-control-plane cp#358).
//
// core#178 measured two PRs (#176, #177) that changed src/ and shipped with zero CHANGELOG lines,
// caught only because a human went to read RELEASES.md instead of trusting a description of it.
// tests/changelog-version.test.ts (core#119/#146) only compares the top heading against
// package.json; it has no opinion on whether a given PR added an entry at all.
//
// core#202 measured core#195 re-resolved on CHANGELOG.md FOUR times with its own content never
// changing, because every sibling PR that merged moved the single shared heading main was
// appending under. Ported fix: entries move into changelog.d/<issue>-<slug>.md fragment files, one
// per PR, so two PRs adding two different files never touch the same file and the conflict class
// disappears rather than being resolved repeatedly.
//
// core#212 measured every PR branched before a released heading closed landing its diff INSIDE the
// section that heading became, with a clean merge every time -- the diff is correct, the heading it
// targeted is what moved. A fragment file carries no heading reference at all, so this class cannot
// occur for a PR that uses one: there is no heading for the file content to be misfiled under.
//
// THREE-DOT, matching vivijure-cf and vivijure-control-plane. changedFiles() diffs BASE...HEAD
// (from the merge base), not BASE..HEAD, so a moving main cannot lend this PR a sibling PR
// CHANGELOG.md edit and vacuously satisfy the guard.
//
// TWO WAYS TO SATISFY THIS, matching the migration window used in the sibling repos: a direct
// CHANGELOG.md edit OR a changelog.d/ fragment. Tightening to fragment-only is a deliberate later
// step, not this change.
//
// Logic lives here rather than in the workflow so it can be driven by a test against a synthetic
// repository, including a fixture that reproduces the two-dot false pass. See
// tests/changelog-entry-required.test.ts.

import { execFileSync } from "node:child_process";

export const GATED_PREFIXES = ["src/"];

export function changedFiles(root, base, head, twoDot) {
  const spec = twoDot ? [base, head] : [base + "..." + head];
  const out = execFileSync("git", ["-C", root, "diff", "--name-only", ...spec], {
    encoding: "utf8",
  });
  return out.split("\n").filter((line) => line.trim().length > 0);
}

export function hasFragment(files) {
  // A changelog.d/ touch that is an actual fragment, not the tracked .gitkeep placeholder --
  // otherwise the guard degenerates to did-you-touch-this-directory, which an unrelated or
  // accidental touch would satisfy without adding any entry at all.
  return files.some((f) => f.startsWith("changelog.d/") && f !== "changelog.d/.gitkeep");
}

export function verdict(files, labels) {
  const labelSet = labels || [];
  if (labelSet.some((l) => l === "no-changelog")) {
    return {
      ok: true,
      message: "no-changelog label present: deliberate skip, recorded on the PR.",
    };
  }
  const touchesCode = files.some((f) => GATED_PREFIXES.some((p) => f.startsWith(p)));
  if (!touchesCode) {
    return { ok: true, message: "no src/ changes." };
  }
  if (files.includes("CHANGELOG.md")) {
    return { ok: true, message: "src/ changed and CHANGELOG.md was updated." };
  }
  if (hasFragment(files)) {
    return { ok: true, message: "src/ changed and a changelog.d/ fragment was added." };
  }
  return {
    ok: false,
    message:
      "This PR touches src/ but neither CHANGELOG.md nor a changelog.d/ fragment changed. " +
      "Preferred: add a fragment file under changelog.d/ (see CONTRIBUTING.md) named " +
      "<issue>-<slug>.md, containing the ### block that would have gone under the open " +
      "changelog heading. CHANGELOG.md itself is still accepted during the migration window. " +
      "Or apply the no-changelog label if this is a deliberate skip.",
  };
}

function main(argv) {
  const root = argv[2];
  const base = argv[3];
  const head = argv[4];
  const labelsJson = argv[5];
  let labels = [];
  if (labelsJson && labelsJson.trim().length > 0) {
    try {
      labels = JSON.parse(labelsJson);
    } catch {
      labels = [];
    }
  }
  const files = changedFiles(root, base, head, false);
  console.log("Changed files (three-dot, from the merge base):");
  for (const f of files) {
    console.log("  " + f);
  }
  const result = verdict(files, labels);
  if (!result.ok) {
    console.log("::error::" + result.message);
    return 1;
  }
  console.log("OK: " + result.message);
  return 0;
}

if (import.meta.url === "file://" + process.argv[1]) {
  process.exit(main(process.argv));
}
