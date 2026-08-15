// Reproduces core#212 at the git level: a PR branched before a released heading closes lands its
// diff INSIDE the section that heading becomes, with a clean merge every time. core#212 own text:
// "The author targeted an unreleased section. The section was published underneath them. The diff
// still applies perfectly." A test asserting "no conflict" would be worthless here (the merge is
// clean either way); this asserts WHERE the entry landed, not whether the merge succeeded.
//
// Two branches, same base, same release-cut race. A direct CHANGELOG.md edit is reproduced landing
// inside the now-released section (the bug). A changelog.d/ fragment is proven immune: it has no
// heading to be misfiled under, so it survives the same race untouched and unconflicted.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

const BASE_CHANGELOG = "# Changelog\n\n## Unreleased\n\n## [1.0.0] -- 2026-01-01\n\n### old\n";

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "core-212-repro-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  mkdirSync(join(root, "changelog.d"), { recursive: true });
  writeFileSync(join(root, "changelog.d", ".gitkeep"), "");
  writeFileSync(join(root, "CHANGELOG.md"), BASE_CHANGELOG);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

// Simulates the OLD hand-edit release step this repo actually used before core#202: rename the
// open heading to a released one in place. This is the exact release-time action that produced
// core#212 -- a section a PR was mid-flight against gets published underneath it.
function renameOpenHeadingToReleased(root: string): void {
  const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const renamed = text.replace("## Unreleased\n", "## [1.1.0] -- 2026-08-14\n");
  writeFileSync(join(root, "CHANGELOG.md"), renamed);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "release: cut 1.1.0 (hand-edit, the pre-core#202 shape)");
}

describe("core#212: a PR branched before the open heading closes", () => {
  it("REPRODUCTION: a direct CHANGELOG.md edit merges clean and lands inside the now-released section", () => {
    const root = initRepo();

    git(root, "checkout", "-qb", "pr-direct");
    const withEntry = BASE_CHANGELOG.replace(
      "## Unreleased\n",
      "## Unreleased\n\n### feat(x): new thing (core#999)\n",
    );
    writeFileSync(join(root, "CHANGELOG.md"), withEntry);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "pr-direct: add entry under Unreleased");

    git(root, "checkout", "-q", "main");
    renameOpenHeadingToReleased(root);

    // The merge succeeds with zero conflicts -- that is the defect, not the absence of one.
    git(root, "merge", "-q", "--no-edit", "pr-direct");

    const merged = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const releasedBounds = merged.indexOf("## [1.1.0]");
    const nextHeading = merged.indexOf("## [1.0.0]");
    const entryPos = merged.indexOf("feat(x): new thing (core#999)");

    expect(entryPos).toBeGreaterThan(-1);
    // THE BUG: the entry sits between the released heading and the next one, i.e. INSIDE the
    // section that was already published, not under any open Unreleased heading (there is none).
    expect(merged.includes("## Unreleased\n\n### feat(x)")).toBe(false);
    expect(entryPos).toBeGreaterThan(releasedBounds);
    expect(entryPos).toBeLessThan(nextHeading);
  });

  it("PROOF: the same race does not exist for a changelog.d/ fragment", () => {
    const root = initRepo();

    git(root, "checkout", "-qb", "pr-fragment");
    writeFileSync(
      join(root, "changelog.d", "999-new-thing.md"),
      "### feat(x): new thing (core#999)\n",
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "pr-fragment: add a changelog.d/ fragment");

    git(root, "checkout", "-q", "main");
    renameOpenHeadingToReleased(root);

    // No conflict here either -- the fragment touches a file the release commit never touched.
    git(root, "merge", "-q", "--no-edit", "pr-fragment");

    const merged = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(merged.includes("core#999")).toBe(false);
    expect(existsSync(join(root, "changelog.d", "999-new-thing.md"))).toBe(true);
    const fragmentBody = readFileSync(join(root, "changelog.d", "999-new-thing.md"), "utf8");
    expect(fragmentBody).toContain("core#999");
    // Nothing in CHANGELOG.md moved or claims this entry -- there is no heading it could have
    // been misfiled under. It sits, correctly, waiting for the next changelog-assemble.mjs run.
  });
});
