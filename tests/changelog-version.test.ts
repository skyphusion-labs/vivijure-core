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
import { readdirSync, readFileSync } from "node:fs";
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
  // Parse ONLY the first ## heading. Alternating whole-file regexes with /m wrongly pick a later
  // ## vX.Y.Z (e.g. "## v1.7.3") over a top "## [1.8.1]" because the unbracketed form is tried
  // first and matches mid-file. Newest-first changelogs always state the live claim in the first
  // ## line.
  const lineMatch = /^##\s+(.+)$/m.exec(changelog);
  if (!lineMatch) return null;
  const rest = lineMatch[1].trim();
  // No trailing \b after \] -- word-boundary fails between ] and newline (## [Unreleased]).
  const unreleased =
    /^(?:\[Unreleased\]|Unreleased)(?:\s*\/\s*v?(\d+\.\d+\.\d+))?(?:\s|$)/i.exec(rest);
  if (unreleased) {
    return { version: unreleased[1] ?? null, unreleased: true };
  }
  const released =
    /^v(\d+\.\d+\.\d+)\b/.exec(rest) ?? /^\[(\d+\.\d+\.\d+)\]/.exec(rest);
  if (released) {
    return { version: released[1], unreleased: false };
  }
  return null;
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

  it("CONTROL: top bracketed heading wins over a later bare ## vX.Y.Z (1.8.1 shape)", () => {
    // Real CHANGELOG after the 1.8.1 cut: ## [1.8.1] first, ## v1.7.3 still present lower down.
    // The old whole-file alternation picked 1.7.3 and failed main green.
    const sample =
      "# Changelog\n\n## [1.8.1] -- 2026-08-06\n\nnotes\n\n## [1.8.0] -- 2026-08-06\n\n## v1.7.3\n\nPATCH\n";
    expect(topChangelogClaim(sample)).toEqual({ version: "1.8.1", unreleased: false });
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

// -------------------------------------------------------------------------------------------------
// core#236: A FRAGMENT ON A SPENT VERSION IS UNRELEASABLE WORK.
//
// WHAT BROKE. core#146 gave this file a guard meant to stop work accumulating on an already-released
// version. It reads the TOP CHANGELOG HEADING, because at the time every PR carrying a change also
// edited CHANGELOG.md, so the heading was where the version became visible. core#224 then introduced
// `changelog.d/` fragments precisely so a PR would NOT have to touch CHANGELOG.md -- and that removed
// the only place this guard could see anything.
//
// The result is a guard that did not fail. It simply stopped having something to look at, and stayed
// green. A fragment-only PR leaves a tree that is byte-for-byte post-release-main shaped: top heading
// and package.json agree on the spent version, the tag exists, nothing is Unreleased. The existing
// assertions above accept that, correctly, because it is also what genuinely idle main looks like.
//
// MEASURED ON THE v1.16.0 CUT. Both PRs of that cycle (#233, #235) used fragments, neither bumped,
// both merged green, and `changelog-assemble.mjs` then refused at cut time with "does not open with
// an Unreleased-shaped heading. Nothing to promote." The refusal is loud and recoverable in one step,
// so this was never a correctness hole -- but it lands on WHOEVER CUTS NEXT rather than on whoever
// caused it, and a defect that migrates away from its author is the worst place for one to sit.
//
// WHAT THE NEW PREDICATE ADDS, and the boundary matters more than the rule. It refuses exactly ONE
// state and three neighbouring states must stay green, including one that is not obvious:
//
//   open-cycle                  top heading is Unreleased-shaped. Fragments are the normal way to
//                               contribute to an open cycle. (Unreleased sitting on a SPENT version
//                               is already refused by the core#117 block above; not re-litigated.)
//   unreleased-version          top heading is a RELEASED form whose version has NO tag yet. This is
//                               the release PR itself, in flight, after assemble and before the tag.
//                               NOT hypothetical: PR #237 was in exactly this state. A guard that
//                               reddened here would block every release PR it was written to serve.
//   post-release-clean          released heading, version tagged, changelog.d EMPTY. Ordinary main.
//                               Reddening here would block every merge after a release.
//   fragments-on-spent-version  released heading, version tagged, AND fragments waiting. REFUSED.
//                               There is no version for that work to be released under.
//
// WHY IT IS NOT VACUOUS. The refusal depends on a tag being VISIBLE, so a clone without tags would
// conclude "not tagged" and pass, silently, on the exact tree this exists to catch. The tag list is
// therefore asserted non-empty, but only on the branch where a conclusion is actually being drawn --
// when fragments exist. CI already sets fetch-tags (.github/workflows/ci.yml).
// -------------------------------------------------------------------------------------------------

/**
 * The cycle state a tree is in, as far as releasability of pending work is concerned.
 * Exactly one of these is a defect; see the block comment above for why the other three are not.
 */
export type CycleState =
  | "open-cycle"
  | "unreleased-version"
  | "post-release-clean"
  | "fragments-on-spent-version";

/**
 * Fragment files awaiting a release cut.
 *
 * DOTFILES ARE EXCLUDED. `changelog.d/.gitkeep` is scaffolding that keeps the directory in git; it is
 * not pending work, and counting it would put every tree permanently in the refused state. A missing
 * directory reads as no fragments rather than throwing: this guard must not be the thing that breaks
 * a checkout, and the assemble script is what owns the directory's existence.
 */
export function listChangelogFragments(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith(".")).sort();
  } catch {
    return [];
  }
}

/** Classify a tree. Pure, so every state can be exercised without constructing one on disk. */
export function cycleState(args: {
  claim: ChangelogClaim | null;
  pkgVersion: string;
  tags: readonly string[];
  fragments: readonly string[];
}): CycleState {
  const { claim, pkgVersion, tags, fragments } = args;
  if (claim?.unreleased) return "open-cycle";
  if (!versionAlreadyTagged(pkgVersion, tags)) return "unreleased-version";
  return fragments.length > 0 ? "fragments-on-spent-version" : "post-release-clean";
}

describe("a changelog.d fragment cannot sit on an already-tagged version (core#236)", () => {
  it("this tree is not accumulating unreleasable work", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const claim = topChangelogClaim(readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8"));
    const fragments = listChangelogFragments(join(repoRoot, "changelog.d"));
    const tags = listCoreReleaseTags();

    if (fragments.length > 0) {
      // Only assert the tag list where a conclusion depends on it. A tagless clone would classify
      // every version as untagged and pass this suite while the defect sat in the tree.
      expect(
        tags.length,
        "no vivijure-core-v* tags visible; CI must fetch-tags and local clones need git fetch --tags " +
          "or this guard cannot tell a spent version from an open one",
      ).toBeGreaterThan(0);
    }

    const state = cycleState({ claim, pkgVersion: pkg.version, tags, fragments });
    expect(
      state,
      `changelog.d holds ${fragments.length} fragment(s) (${fragments.join(", ")}) but package.json ` +
        `is ${pkg.version}, which is already tagged ${TAG_PREFIX}${pkg.version}, and CHANGELOG.md ` +
        `opens with a released heading. That work has no version to be released under, and ` +
        `scripts/changelog-assemble.mjs will refuse at cut time with "nothing to promote". Open the ` +
        `cycle: bump package.json (and package-lock.json) and add a "## Unreleased / v<next>" ` +
        `heading. See RELEASES.md and core#236.`,
    ).not.toBe("fragments-on-spent-version");
  });

  it("CONTROL: the defect, planted -- released heading + tagged version + a fragment is REFUSED", () => {
    // The reconstructed v1.16.0 cut state, one PR earlier: #235's fragment merged, no bump.
    expect(
      cycleState({
        claim: topChangelogClaim("# Changelog\n\n## [1.15.0] -- 2026-08-15\n\nnotes\n"),
        pkgVersion: "1.15.0",
        tags: ["vivijure-core-v1.14.0", "vivijure-core-v1.15.0"],
        fragments: ["pr-cf475-cast-train-job-log.md"],
      }),
    ).toBe("fragments-on-spent-version");
  });

  it("CONTROL: post-release main with an EMPTY changelog.d is green (else every merge blocks)", () => {
    expect(
      cycleState({
        claim: topChangelogClaim("# Changelog\n\n## [1.15.0] -- 2026-08-15\n\nnotes\n"),
        pkgVersion: "1.15.0",
        tags: ["vivijure-core-v1.15.0"],
        fragments: [],
      }),
    ).toBe("post-release-clean");
  });

  it("CONTROL: fragments under an OPEN cycle heading are the normal case, not a defect", () => {
    expect(
      cycleState({
        claim: topChangelogClaim("# Changelog\n\n## Unreleased / v1.16.0\n\n"),
        pkgVersion: "1.16.0",
        tags: ["vivijure-core-v1.15.0"],
        fragments: ["232-scan-cache-key-comment.md", "pr-cf475-cast-train-job-log.md"],
      }),
    ).toBe("open-cycle");
  });

  it("CONTROL: the release PR itself -- released heading, version NOT yet tagged -- is green", () => {
    // PR #237 was exactly this: CHANGELOG closed to ## [1.16.0], package.json 1.16.0, tag not cut.
    // A fragment landing alongside it is still releasable under 1.16.0.
    expect(
      cycleState({
        claim: topChangelogClaim("# Changelog\n\n## [1.16.0] -- 2026-08-15\n\nnotes\n"),
        pkgVersion: "1.16.0",
        tags: ["vivijure-core-v1.15.0"],
        fragments: ["some-late-fragment.md"],
      }),
    ).toBe("unreleased-version");
  });

  it("CONTROL: .gitkeep is scaffolding, not pending work", () => {
    // Reading the REAL directory, which holds exactly .gitkeep on a clean post-release tree. If this
    // counted, every tree would sit permanently in the refused state and the guard would be noise.
    const real = listChangelogFragments(join(repoRoot, "changelog.d"));
    expect(real).not.toContain(".gitkeep");
    // Positive control on the filter: it is not simply returning an empty list for everything.
    expect(listChangelogFragments(join(repoRoot, "tests")).length).toBeGreaterThan(0);
  });

  it("CONTROL: a missing changelog.d reads as no fragments rather than throwing", () => {
    expect(listChangelogFragments(join(repoRoot, "changelog.d-does-not-exist"))).toEqual([]);
  });

  it("CONTROL: with NO tags visible the classifier CANNOT see the defect -- which is what the tag assertion is for", () => {
    // The exact tree of PLANT 1, classified against an empty tag list: it comes back
    // "unreleased-version", i.e. GREEN. The classifier is not wrong -- with no tags there is no
    // evidence the version is spent -- but it means a tagless clone would pass this suite while the
    // defect sat in the tree, which is the vacuous green core#119 already had to fix once for the
    // Unreleased branch. The `expect(tags.length).toBeGreaterThan(0)` above is the only thing
    // standing between those two outcomes, so this control names what it is protecting.
    const defectShape = {
      claim: topChangelogClaim("# Changelog\n\n## [1.16.0] -- 2026-08-15\n\nnotes\n"),
      pkgVersion: "1.16.0",
      fragments: ["999-planted.md"],
    };
    expect(cycleState({ ...defectShape, tags: ["vivijure-core-v1.16.0"] }))
      .toBe("fragments-on-spent-version");
    expect(cycleState({ ...defectShape, tags: [] }))
      .toBe("unreleased-version");
    // And the real helper genuinely can return empty, so this is not a hypothetical shape:
    // a clone without `git fetch --tags` is exactly it.
    expect(listCoreReleaseTags("/nonexistent-repo-path")).toEqual([]);
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
