// Drives scripts/changelog-entry-required.mjs against a synthetic repository and against pure
// input lists (core#178, core#202, core#212 -- entries move to changelog.d/ fragments so a
// misfiled heading race cannot happen for a PR that uses one).
//
// THE FIXTURE IS THE POINT, matching the sibling suite in vivijure-cf
// (tests/changelog-entry-required.test.py). Asserts BOTH directions on the same synthetic
// repository: two-dot passes vacuously (the bug class this guard exists to avoid), three-dot
// refuses correctly (the fix).

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedFiles,
  verdict,
  hasFragment,
  GATED_PREFIXES,
} from "../scripts/changelog-entry-required.mjs";

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function rev(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function buildRepo() {
  const root = mkdtempSync(join(tmpdir(), "core-changelog-guard-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const base = rev(root);

  git(root, "checkout", "-qb", "pr");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "pr: src only, no changelog entry");
  const head = rev(root);

  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n### someone else\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "other PR: touches CHANGELOG.md");
  const movedBase = rev(root);

  return { root, base, head, movedBase };
}

describe("changelog-entry-required (core#178, core#202, core#212)", () => {
  it("CONTROL: two-dot against a moved base passes vacuously (the bug the fix avoids)", () => {
    const built = buildRepo();
    const files = changedFiles(built.root, built.movedBase, built.head, true);
    const result = verdict(files);
    expect(result.ok).toBe(true);
    expect(files).toContain("CHANGELOG.md");
    expect(files).toContain("src/a.ts");
  });

  it("three-dot refuses a src-only PR whose base merely happens to carry a changelog change", () => {
    const built = buildRepo();
    const files = changedFiles(built.root, built.movedBase, built.head, false);
    const result = verdict(files);
    expect(result.ok).toBe(false);
    expect(files).not.toContain("CHANGELOG.md");
    expect(files).toContain("src/a.ts");
    expect(result.message).toContain("neither CHANGELOG.md nor a changelog.d/ fragment");
  });

  it("a PR carrying its own entry still passes", () => {
    const built = buildRepo();
    git(built.root, "checkout", "-q", "pr");
    writeFileSync(join(built.root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n### ours\n");
    git(built.root, "add", "-A");
    git(built.root, "commit", "-qm", "pr: add our own entry");
    const head2 = rev(built.root);
    const files = changedFiles(built.root, built.movedBase, head2, false);
    expect(verdict(files).ok).toBe(true);
  });

  it("a docs-only PR needs no entry", () => {
    expect(verdict(["docs/x.md", "tests/y.ts"]).ok).toBe(true);
  });

  it("the no-changelog label is a loud escape hatch, and its absence is refused (CONTROL)", () => {
    expect(verdict(["src/a.ts"], ["no-changelog"]).ok).toBe(true);
    expect(verdict(["src/a.ts"]).ok).toBe(false);
  });

  it("PROOF: src/ change with neither CHANGELOG.md nor a fragment is refused, naming both forms", () => {
    const result = verdict(["src/a.ts"]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("changelog.d/");
    expect(result.message).toContain("CHANGELOG.md");
  });

  it("PROOF: a changelog.d/ fragment alone is accepted", () => {
    expect(verdict(["src/a.ts", "changelog.d/178-entry-required.md"]).ok).toBe(true);
  });

  it("PROOF: CHANGELOG.md alone is still accepted (migration window)", () => {
    expect(verdict(["src/a.ts", "CHANGELOG.md"]).ok).toBe(true);
  });

  it("CONTROL: touching changelog.d/.gitkeep alone does not satisfy the guard", () => {
    expect(hasFragment(["changelog.d/.gitkeep"])).toBe(false);
    expect(verdict(["src/a.ts", "changelog.d/.gitkeep"]).ok).toBe(false);
  });

  it("GATED_PREFIXES is src/ only -- core has no public/ or modules/ top-level surface", () => {
    expect(GATED_PREFIXES).toEqual(["src/"]);
  });
});
