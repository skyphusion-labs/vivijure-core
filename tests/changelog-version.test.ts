// package.json version vs CHANGELOG claim, spent-version + Unreleased, and package-lock (core#119).
//
// Sibling of vivijure-cf tests/changelog-version.test.ts (cf#274). core#117 merged green with its
// entry under ## [Unreleased] and package.json still at 1.4.0 -- already tagged
// vivijure-core-v1.4.0 and on npm. Review passed; the refuse only came at tag / publish time.
//
// This is the REVIEW-time half. Two assertions (issue #119):
//
// 1. Top changelog heading claims the same version as package.json. Accepts released forms
//    (## vX.Y.Z, ## [X.Y.Z] -- date) and unreleased forms (## Unreleased / vX.Y.Z, bare
//    ## Unreleased with package.json as the implied claim).
// 2. When the top heading is Unreleased, the package.json version must NOT already be a git tag
//    vivijure-core-vX.Y.Z. That is the exact core#117 shape. Post-release main (## v1.7.3 +
//    package.json 1.7.3 + tag present) stays green; only Unreleased-on-a-spent-version fails.
//
// package-lock.json is a third copy (cf#273 / core#119 adjacent): top-level version and
// packages[""].version must match package.json.
//
// POSITIVE CONTROLS: every parser is proven against a planted mismatch using the same predicate
// the real check uses (reconstructed-defect standard).

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");

const TAG_PREFIX = "vivijure-core-v";

/** First ## heading claim. null when nothing matches a known shape (fail closed). */
export type ChangelogClaim = {
  /** Semver from the heading, or null for bare ## Unreleased / ## [Unreleased]. */
  version: string | null;
  unreleased: boolean;
};

/**
 * Newest changelog heading. Forms:
 *   ## Unreleased / v1.8.0
 *   ## Unreleased / 1.8.0
 *   ## Unreleased
 *   ## [Unreleased]
 *   ## v1.7.3
 *   ## v1.7.3 -- 2026-08-05
 *   ## [1.7.2] -- 2026-08-03
 *   ## [1.7.2]
 */
export function topChangelogClaim(changelog: string): ChangelogClaim | null {
  // No trailing \b after \] -- word-boundary fails between ] and newline (## [Unreleased]).
  const m =
    /^##\s+(?:\[Unreleased\]|Unreleased)(?:\s*\/\s*v?(\d+\.\d+\.\d+))?(?:\s|$)/m.exec(changelog) ??
    /^##\s+v(\d+\.\d+\.\d+)\b/m.exec(changelog) ??
    /^##\s+\[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  if (!m) return null;
  const full = m[0];
  const unreleased = /Unreleased/i.test(full);
  const version = m[1] ?? null;
  return { version, unreleased };
}

/** Effective version the changelog claims for comparison to package.json. */
export function claimedVersion(claim: ChangelogClaim, pkgVersion: string): string | null {
  if (claim.version) return claim.version;
  if (claim.unreleased) return pkgVersion;
  return null;
}

/** True when tags includes vivijure-core-v${version} (exact). */
export function versionAlreadyTagged(version: string, tags: readonly string[]): boolean {
  const want = `${TAG_PREFIX}${version}`;
  return tags.some((t) => t === want || t.endsWith(`/${want}`));
}

/** Top-level + packages[""].version from a lockfile v3 shape. null if malformed. */
export function lockFileVersions(lockJson: string): { top: string; root: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const packages = obj.packages;
  if (typeof obj.version !== "string" || typeof packages !== "object" || packages === null) {
    return null;
  }
  const rootEntry = (packages as Record<string, unknown>)[""];
  if (typeof rootEntry !== "object" || rootEntry === null) return null;
  const rootVersion = (rootEntry as Record<string, unknown>).version;
  if (typeof rootVersion !== "string") return null;
  return { top: obj.version, root: rootVersion };
}

/** Local tags matching vivijure-core-v*. CI must fetch-tags (see .github/workflows/ci.yml). */
export function listCoreReleaseTags(cwd: string = repoRoot): string[] {
  try {
    const out = execSync(`git tag -l "${TAG_PREFIX}*"`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe("package.json version matches the top CHANGELOG claim (core#119)", () => {
  it("agrees with the newest CHANGELOG heading, and the real files are not a vacuous null pass", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    const claim = topChangelogClaim(changelog);
    expect(claim, "CHANGELOG.md has no recognised ## heading to compare against").not.toBeNull();
    expect(typeof pkg.version).toBe("string");
    const claimed = claimedVersion(claim!, pkg.version);
    expect(claimed, "CHANGELOG claim did not resolve to a version").not.toBeNull();
    expect(
      claimed,
      `package.json declares ${pkg.version} but the top CHANGELOG claim is ${claimed}; bump whichever lagged`,
    ).toBe(pkg.version);
  });

  it("CONTROL: released ## vX.Y.Z and bracketed ## [X.Y.Z] parsers", () => {
    expect(topChangelogClaim("# Changelog\n\n## v2.4.1 -- 2026-01-01\n\nnotes\n")).toEqual({
      version: "2.4.1",
      unreleased: false,
    });
    expect(topChangelogClaim("# Changelog\n\n## [1.7.2] -- 2026-08-03\n\nnotes\n")).toEqual({
      version: "1.7.2",
      unreleased: false,
    });
  });

  it("CONTROL: Unreleased / vX and bare Unreleased", () => {
    expect(topChangelogClaim("# Changelog\n\n## Unreleased / v1.8.0\n\nnotes\n")).toEqual({
      version: "1.8.0",
      unreleased: true,
    });
    expect(topChangelogClaim("# Changelog\n\n## Unreleased / 1.8.0\n\nnotes\n")).toEqual({
      version: "1.8.0",
      unreleased: true,
    });
    expect(topChangelogClaim("# Changelog\n\n## [Unreleased]\n\nnotes\n")).toEqual({
      version: null,
      unreleased: true,
    });
    expect(topChangelogClaim("# Changelog\n\n## Unreleased\n\nnotes\n")).toEqual({
      version: null,
      unreleased: true,
    });
  });

  it("CONTROL: a planted package.json vs changelog mismatch is what this test catches", () => {
    const pkgVersion = "1.4.0";
    const claim = topChangelogClaim("# Changelog\n\n## Unreleased / v1.5.0\n\nnotes\n");
    expect(claimedVersion(claim!, pkgVersion) === pkgVersion).toBe(false);
  });
});

describe("Unreleased work cannot sit on an already-tagged version (core#119 / core#117 shape)", () => {
  it("when the top heading is Unreleased, package.json version must not already be tagged", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    const claim = topChangelogClaim(changelog);
    expect(claim).not.toBeNull();
    if (!claim!.unreleased) {
      // Post-release main: ## vX.Y.Z matching package.json; tag may exist. Nothing to assert.
      return;
    }
    const tags = listCoreReleaseTags();
    expect(
      tags.length,
      "no vivijure-core-v* tags visible; CI must fetch-tags and local clones need git fetch --tags " +
        "or this guard is a vacuous green",
    ).toBeGreaterThan(0);
    expect(
      versionAlreadyTagged(pkg.version, tags),
      `package.json is ${pkg.version} and CHANGELOG is still Unreleased, but ${TAG_PREFIX}${pkg.version} ` +
        `already exists. Bump package.json (and claim that version under Unreleased) before landing ` +
        `more work -- this is the core#117 failure mode.`,
    ).toBe(false);
  });

  it("CONTROL: core#117 reconstructed -- Unreleased + package.json at already-tagged 1.4.0 is RED", () => {
    // Exact defect: entry under Unreleased, package.json still 1.4.0, tag vivijure-core-v1.4.0 present.
    const pkgVersion = "1.4.0";
    const claim = topChangelogClaim("# Changelog\n\n## [Unreleased]\n\n### feat(x)\n");
    expect(claim?.unreleased).toBe(true);
    const tags = ["vivijure-core-v1.3.0", "vivijure-core-v1.4.0", "vivijure-core-v1.5.0"];
    expect(versionAlreadyTagged(pkgVersion, tags)).toBe(true);
    // Combined predicate the real test uses: unreleased AND tagged => refuse.
    expect(claim!.unreleased && versionAlreadyTagged(pkgVersion, tags)).toBe(true);
  });

  it("CONTROL: Unreleased / v1.8.0 with no 1.8.0 tag is green", () => {
    const pkgVersion = "1.8.0";
    const claim = topChangelogClaim("# Changelog\n\n## Unreleased / v1.8.0\n\nnotes\n");
    const tags = ["vivijure-core-v1.7.2", "vivijure-core-v1.7.3"];
    expect(claim?.unreleased).toBe(true);
    expect(claimedVersion(claim!, pkgVersion)).toBe(pkgVersion);
    expect(versionAlreadyTagged(pkgVersion, tags)).toBe(false);
  });

  it("CONTROL: released heading with matching version may coexist with its tag", () => {
    const pkgVersion = "1.7.3";
    const claim = topChangelogClaim("# Changelog\n\n## v1.7.3\n\nPATCH notes\n");
    const tags = ["vivijure-core-v1.7.3"];
    expect(claim?.unreleased).toBe(false);
    expect(claimedVersion(claim!, pkgVersion)).toBe(pkgVersion);
    // Tag present is fine when not Unreleased -- this is post-release main.
    expect(claim!.unreleased && versionAlreadyTagged(pkgVersion, tags)).toBe(false);
  });

  it("CONTROL: versionAlreadyTagged is exact, not a prefix match on a longer tag", () => {
    expect(versionAlreadyTagged("1.7.0", ["vivijure-core-v1.7.0", "vivijure-core-v1.7.01"])).toBe(
      true,
    );
    expect(versionAlreadyTagged("1.7", ["vivijure-core-v1.7.0"])).toBe(false);
    expect(versionAlreadyTagged("1.7.0", ["vivijure-core-v1.7.01"])).toBe(false);
  });
});

describe("package-lock.json agrees with package.json (core#119 adjacent / cf#274)", () => {
  it("both the top-level version and packages[\"\"].version match package.json", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const lockRaw = readFileSync(join(repoRoot, "package-lock.json"), "utf8");
    const lock = lockFileVersions(lockRaw);
    expect(lock, "package-lock.json is missing or malformed at the fields this check reads").not.toBeNull();
    expect(
      lock?.top,
      `package-lock.json top-level version is ${lock?.top} but package.json declares ${pkg.version}`,
    ).toBe(pkg.version);
    expect(
      lock?.root,
      `package-lock.json packages[""].version is ${lock?.root} but package.json declares ${pkg.version}`,
    ).toBe(pkg.version);
  });

  it("CONTROL: the parser reads a planted lock file with both fields present", () => {
    const planted = JSON.stringify({
      version: "2.4.1",
      packages: { "": { version: "2.4.1" } },
    });
    expect(lockFileVersions(planted)).toEqual({ top: "2.4.1", root: "2.4.1" });
  });

  it("CONTROL: a planted mismatch on the top-level field is what this test exists to catch", () => {
    const planted = JSON.stringify({
      version: "1.4.0",
      packages: { "": { version: "1.5.0" } },
    });
    const lock = lockFileVersions(planted);
    expect(lock?.top === "1.5.0").toBe(false);
  });

  it("CONTROL: a planted mismatch on packages[\"\"].version is what this test exists to catch", () => {
    const planted = JSON.stringify({
      version: "1.5.0",
      packages: { "": { version: "1.4.0" } },
    });
    const lock = lockFileVersions(planted);
    expect(lock?.root === "1.5.0").toBe(false);
  });

  it("CONTROL: malformed JSON and a missing root package entry both fail closed", () => {
    expect(lockFileVersions("not json")).toBeNull();
    expect(lockFileVersions(JSON.stringify({ version: "1.0.0", packages: {} }))).toBeNull();
  });
});
