// Drives scripts/changelog-assemble.mjs against synthetic fixtures (core#202). Ported design from
// vivijure-cf scripts/changelog-assemble.py (cf#546) and vivijure-control-plane (cp#358), adapted:
// this script RENAMES the open Unreleased-shaped heading into the released one rather than leaving
// a permanent empty Unreleased anchor above it, because tests/changelog-version.test.ts (core#146)
// refuses a bare Unreleased heading sitting on an already-tagged package.json version, and a
// permanent anchor would make that fire on every single release cut, before the next feature PR
// bumps package.json. See the top-of-file comment in scripts/changelog-assemble.mjs for the full
// reasoning.

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  assemble,
  normalizeVersion,
  versionHeadingPresent,
  openSectionBounds,
} from "../scripts/changelog-assemble.mjs";

describe("changelog-assemble (core#202)", () => {
  it("PROOF: fragment-only assembly is byte-correct against a written fixture", () => {
    const base =
      "# Changelog\n\nAll notable changes.\n\n## Unreleased\n\n## [1.0.0] -- 2026-01-01\n\n### old release\n";
    const result = assemble(
      base,
      ["100-a.md", "200-b.md"],
      ["### feat(x): a (core#100)\n\nbody a.", "### fix(y): b (core#200)\n\nbody b."],
      "v1.1.0",
      "2026-08-14",
    );
    const expected =
      "# Changelog\n\nAll notable changes.\n\n## [1.1.0] -- 2026-08-14\n\n" +
      "### feat(x): a (core#100)\n\nbody a.\n\n### fix(y): b (core#200)\n\nbody b.\n\n" +
      "## [1.0.0] -- 2026-01-01\n\n### old release\n";
    expect(result.ok).toBe(true);
    expect(result.text).toBe(expected);
  });

  it("PROOF: legacy-Unreleased-only assembly (no fragments) matches the direct-edit case", () => {
    const base =
      "# Changelog\n\n## Unreleased\n\n### direct edit, no fragment\n\nprose.\n\n" +
      "## [1.0.0] -- 2026-01-01\n\n### old\n";
    const result = assemble(base, [], [], "v1.1.0", "2026-08-14");
    const expected =
      "# Changelog\n\n## [1.1.0] -- 2026-08-14\n\n### direct edit, no fragment\n\nprose.\n\n" +
      "## [1.0.0] -- 2026-01-01\n\n### old\n";
    expect(result.ok).toBe(true);
    expect(result.text).toBe(expected);
  });

  it("PROOF: both a legacy body and a fragment land in the same release, legacy first", () => {
    const base =
      "# Changelog\n\n## Unreleased\n\n### direct edit, no fragment\n\nprose.\n\n" +
      "## [1.0.0] -- 2026-01-01\n\n### old\n";
    const result = assemble(
      base,
      ["050-earlier.md"],
      ["### feat(z): fragment entry (core#50)\n\nfragment prose."],
      "v1.1.0",
      "2026-08-14",
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain(
      "### direct edit, no fragment\n\nprose.\n\n### feat(z): fragment entry (core#50)",
    );
  });

  it("PROOF: also renames a Unreleased-slash-version heading, the current core shape", () => {
    const base = "# Changelog\n\n## Unreleased / v1.15.0\n\n### a change\n\n## [1.14.0]\n\n### x\n";
    const result = assemble(base, [], [], "v1.15.0", "2026-08-14");
    expect(result.ok).toBe(true);
    expect(result.text.indexOf("# Changelog\n\n## [1.15.0] -- 2026-08-14")).toBe(0);
    expect(result.text).toContain("### a change");
  });

  it("REFUSES when the top heading is not Unreleased-shaped: nothing to promote", () => {
    const base = "# Changelog\n\n## [1.0.0] -- 2026-01-01\n\n### old\n";
    const result = assemble(base, [], [], "v1.1.0", "2026-08-14");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not open with an Unreleased-shaped heading");
  });

  it("REFUSES when the version heading already exists, bracketed form", () => {
    const base = "# Changelog\n\n## Unreleased\n\n## [1.1.0] -- 2026-08-01\n\n### already there\n";
    const result = assemble(base, ["100-a.md"], ["### new"], "v1.1.0", "2026-08-14");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already appears");
  });

  it("REFUSES the un-prefixed spelling too, normalized before the duplicate check", () => {
    const base = "# Changelog\n\n## Unreleased\n\n## [1.1.0] -- 2026-08-01\n\n### already there\n";
    const result = assemble(base, [], [], "1.1.0", "2026-08-14");
    expect(result.ok).toBe(false);
  });

  it("normalizeVersion accepts both spellings", () => {
    expect(normalizeVersion("1.2.3")).toBe("v1.2.3");
    expect(normalizeVersion("v1.2.3")).toBe("v1.2.3");
  });

  it("versionHeadingPresent is exact, not a prefix match on a longer version", () => {
    const lines = ["## [1.1.0] -- 2026-08-01"];
    expect(versionHeadingPresent(lines, "v1.1.0")).toBe(true);
    expect(versionHeadingPresent(lines, "v1.1.01")).toBe(false);
  });

  it("openSectionBounds is null when the file does not start with an Unreleased-shaped heading", () => {
    expect(openSectionBounds(["## [1.0.0] -- 2026-01-01", "", "### x"])).toBeNull();
    expect(openSectionBounds(["## Unreleased", "", "### x"])).toEqual([0, 3]);
  });

  it("end to end: main() consumes fragments from disk and deletes them, keeps .gitkeep", () => {
    const root = mkdtempSync(join(tmpdir(), "core-changelog-assemble-"));
    writeFileSync(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n## Unreleased\n\n## [1.0.0] -- 2026-01-01\n\n### old\n",
    );
    const dir = join(root, "changelog.d");
    mkdirSync(dir);
    writeFileSync(join(dir, ".gitkeep"), "");
    writeFileSync(join(dir, "200-later.md"), "### later\n\nlater body.");
    writeFileSync(join(dir, "050-earlier.md"), "### earlier\n\nearlier body.");

    const scriptPath = new URL("../scripts/changelog-assemble.mjs", import.meta.url).pathname;
    execFileSync("node", [scriptPath, "v1.1.0", "2026-08-14"], { cwd: root, encoding: "utf8" });

    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual([".gitkeep"]);
    expect(existsSync(join(dir, "200-later.md"))).toBe(false);

    const written = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(written.indexOf("earlier body")).toBeLessThan(written.indexOf("later body"));

    expect(() =>
      execFileSync("node", [scriptPath, "v1.1.0", "2026-08-14"], { cwd: root, encoding: "utf8" }),
    ).toThrow();
  });
});
