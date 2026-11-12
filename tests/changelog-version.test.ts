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
// 2. (core#550, bump-at-release) When the top heading is Unreleased, the package.json version MUST
//    already be a git tag vivijure-core-vX.Y.Z: a version moves only in a release PR, so an
//    Unreleased heading on an UNTAGGED version means a feature PR bumped ahead. The old rule (the
//    core#117 shape, Unreleased on a tagged version, was RED) is the opposite and is retired: that
//    shape is the normal state now. See the block comment below.
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

// -------------------------------------------------------------------------------------------------
// core#550: BUMP-AT-RELEASE. These guards were written for OPEN-ONCE and are rewritten for the
// estate convention (Conrad, ruled 2026-11-10, fleet-chezmoi#1766): a version moves ONLY in a
// release PR, so work accumulates on a version that is already tagged and nobody bumps ahead.
//
// WHAT THEY USED TO REFUSE, AND IS NOW NORMAL.
//   core#119/#146: `## Unreleased` sitting on a package.json version that is already tagged.
//   core#236:      changelog.d fragments sitting on a tagged version under a released heading.
// Under open-once the first feature PR of a cycle had to bump, so both shapes meant "somebody forgot
// to open the cycle". Under bump-at-release both are the steady state: nothing opens a cycle, the
// release PR does.
//
// WHAT THEY REFUSE NOW. Exactly one state, the mirror image of the old one: a package.json version
// that is NOT tagged while the top heading is Unreleased. That is a version that moved outside a
// release PR (the open-once habit): the bump landed in a feature PR, so the release PR no longer
// owns the version and the next cut can mislabel what is in it. A released top heading on an
// untagged version is the RELEASE PR itself, in flight (after assemble, before the tag), and stays
// green.
//
//   open-cycle              top heading Unreleased-shaped, package.json TAGGED. Normal: entries
//                           accumulate (direct edit or fragment). Used to be refused (core#117).
//   bumped-outside-release  top heading Unreleased-shaped, package.json NOT tagged. REFUSED.
//   release-in-flight       top heading released, package.json NOT tagged. The release PR. Green.
//   post-release-clean      top heading released, tagged, changelog.d empty. Ordinary main. Green.
//   fragments-pending       top heading released, tagged, fragments waiting. Normal. Used to be
//                           refused (core#236); the release PR cuts them with changelog-assemble.
//
// WHY IT IS NOT VACUOUS. The refusal depends on a tag being VISIBLE. A clone without tags sees every
// version as untagged, so on an Unreleased heading it reads "bumped-outside-release": a false RED,
// which fails closed and is loud, never a silent green. The tag list is still asserted non-empty
// where a conclusion is drawn, so the message names the real cause (CI sets fetch-tags).
// -------------------------------------------------------------------------------------------------

/** The cycle state a tree is in. Exactly one of these is a defect. */
export type CycleState =
  | "open-cycle"
  | "bumped-outside-release"
  | "release-in-flight"
  | "post-release-clean"
  | "fragments-pending";

/**
 * Fragment files awaiting a release cut.
 *
 * DOTFILES ARE EXCLUDED. `changelog.d/.gitkeep` is scaffolding that keeps the directory in git; it is
 * not pending work. A missing directory reads as no fragments rather than throwing: this guard must
 * not be the thing that breaks a checkout.
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
  const tagged = versionAlreadyTagged(pkgVersion, tags);
  if (claim?.unreleased) return tagged ? "open-cycle" : "bumped-outside-release";
  if (!tagged) return "release-in-flight";
  return fragments.length > 0 ? "fragments-pending" : "post-release-clean";
}

describe("a version moves only in a release PR (bump-at-release, core#550)", () => {
  it("this tree has not bumped outside a release PR", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const claim = topChangelogClaim(readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8"));
    expect(claim).not.toBeNull();
    const fragments = listChangelogFragments(join(repoRoot, "changelog.d"));
    const tags = listCoreReleaseTags();
    if (claim!.unreleased) {
      // Only where a conclusion depends on the tag list: a tagless clone would read every version as
      // untagged and refuse a healthy tree for the wrong reason.
      expect(
        tags.length,
        "no vivijure-core-v* tags visible; CI must fetch-tags and local clones need git fetch --tags " +
          "or this guard cannot tell a released version from an unreleased one",
      ).toBeGreaterThan(0);
    }
    const state = cycleState({ claim, pkgVersion: pkg.version, tags, fragments });
    expect(
      state,
      `CHANGELOG.md opens with an Unreleased heading but package.json is ${pkg.version}, which has no ` +
        `${TAG_PREFIX}${pkg.version} tag: the version moved outside a release PR. Versions move only ` +
        `in the release PR (bump package.json and package-lock.json, then run ` +
        `scripts/changelog-assemble.mjs). Feature PRs add a changelog.d/ fragment and do not bump. ` +
        `See RELEASES.md and core#550.`,
    ).not.toBe("bumped-outside-release");
  });

  it("CONTROL: the OLD open-once defect shapes now PASS -- Unreleased on an already-tagged version (core#117)", () => {
    // Exactly the shape that used to be RED: entry under Unreleased, package.json 1.4.0, tag present.
    const claim = topChangelogClaim("# Changelog\n\n## [Unreleased]\n\n### feat(x)\n");
    expect(claim?.unreleased).toBe(true);
    expect(
      cycleState({
        claim,
        pkgVersion: "1.4.0",
        tags: ["vivijure-core-v1.3.0", "vivijure-core-v1.4.0", "vivijure-core-v1.5.0"],
        fragments: [],
      }),
    ).toBe("open-cycle");
  });

  it("CONTROL: the OLD open-once defect shapes now PASS -- fragments on a tagged version under a released heading (core#236)", () => {
    expect(
      cycleState({
        claim: topChangelogClaim("# Changelog\n\n## [1.15.0] -- 2026-08-15\n\nnotes\n"),
        pkgVersion: "1.15.0",
        tags: ["vivijure-core-v1.14.0", "vivijure-core-v1.15.0"],
        fragments: ["pr-cf475-cast-train-job-log.md"],
      }),
    ).toBe("fragments-pending");
  });

  it("CONTROL: the bump-at-release rule FAILS when broken -- a feature PR that bumps ahead is RED", () => {
    // The open-once habit, planted: bare Unreleased, package.json moved to 1.5.0, no such tag.
    expect(
      cycleState({
        claim: topChangelogClaim("# Changelog\n\n## Unreleased\n\n### feat(x)\n"),
        pkgVersion: "1.5.0",
        tags: ["vivijure-core-v1.4.0"],
        fragments: [],
      }),
    ).toBe("bumped-outside-release");
  });

  it("CONTROL: the old explicit claim `## Unreleased / v1.8.0` on an untagged 1.8.0 is RED too", () => {
    expect(
      cycleState({
        claim: topChangelogClaim("# Changelog\n\n## Unreleased / v1.8.0\n\nnotes\n"),
        pkgVersion: "1.8.0",
        tags: ["vivijure-core-v1.7.2", "vivijure-core-v1.7.3"],
        fragments: [],
      }),
    ).toBe("bumped-outside-release");
  });

  it("CONTROL: the release PR itself -- released heading, version NOT yet tagged -- is green", () => {
    // CHANGELOG closed to ## [1.16.0], package.json 1.16.0, tag not cut. A late fragment alongside it
    // is still releasable under 1.16.0.
    expect(
      cycleState({
        claim: topChangelogClaim("# Changelog\n\n## [1.16.0] -- 2026-08-15\n\nnotes\n"),
        pkgVersion: "1.16.0",
        tags: ["vivijure-core-v1.15.0"],
        fragments: ["some-late-fragment.md"],
      }),
    ).toBe("release-in-flight");
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

  it("CONTROL: a heading that claims the version while its tag exists is the ordinary released state", () => {
    const claim = topChangelogClaim("# Changelog\n\n## v1.7.3\n\nPATCH notes\n");
    expect(claim?.unreleased).toBe(false);
    expect(claimedVersion(claim!, "1.7.3")).toBe("1.7.3");
    expect(
      cycleState({ claim, pkgVersion: "1.7.3", tags: ["vivijure-core-v1.7.3"], fragments: [] }),
    ).toBe("post-release-clean");
  });

  it("CONTROL: with NO tags visible the classifier cannot tell released from unreleased -- the tag assertion names that", () => {
    // A healthy post-release tree with an Unreleased heading reads RED when no tag is visible. That
    // is a loud false red, not a silent green, and the non-empty tag assertion above explains it.
    const healthy = {
      claim: topChangelogClaim("# Changelog\n\n## Unreleased\n\nnotes\n"),
      pkgVersion: "1.16.0",
      fragments: [] as string[],
    };
    expect(cycleState({ ...healthy, tags: ["vivijure-core-v1.16.0"] })).toBe("open-cycle");
    expect(cycleState({ ...healthy, tags: [] })).toBe("bumped-outside-release");
    expect(listCoreReleaseTags("/nonexistent-repo-path")).toEqual([]);
  });

  it("CONTROL: .gitkeep is scaffolding, not pending work; a missing directory is no fragments", () => {
    const real = listChangelogFragments(join(repoRoot, "changelog.d"));
    expect(real).not.toContain(".gitkeep");
    expect(listChangelogFragments(join(repoRoot, "tests")).length).toBeGreaterThan(0);
    expect(listChangelogFragments(join(repoRoot, "changelog.d-does-not-exist"))).toEqual([]);
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
