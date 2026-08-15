// RELEASES.md ledger honesty guard (core#126).
//
// The `published` column used to be filled at version-bump PR time with the literal `pending`,
// and nothing came back after the npm publish to correct it. So `pending` was the value for a
// shipped release and an unshipped one alike -- the column could not answer the question the
// ledger exists for.
//
// Procedure (RELEASES.md "Closing the row"): seed source commit + published EMPTY in the bump PR;
// close them after the registry confirms the publish. This test is the mechanical half of that
// rule: it refuses the pretence literals that made the column useless, and requires a real date
// shape when a cell is filled. It does NOT call the registry (network would make CI flaky and
// would re-implement step 5); the human still settles the date at npm view time.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES_PATH = resolve(root, "RELEASES.md");

interface LedgerRow {
  line: number;
  tag: string;
  npm: string;
  sourceCommit: string;
  published: string;
}

/** Parse the release-ledger markdown table. Header: git tag | npm | source commit | published | notes */
function parseLedger(md: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const lines = md.split(/\r?\n/);
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inTable) {
      if (/^\|\s*git tag\s*\|/i.test(line)) {
        inTable = true;
      }
      continue;
    }
    // Separator row
    if (/^\|\s*-+/.test(line)) continue;
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    // Skip a repeated header if present
    if (/^git tag$/i.test(cells[0])) continue;
    rows.push({
      line: i + 1,
      tag: cells[0],
      npm: cells[1],
      sourceCommit: cells[2],
      published: cells[3],
    });
  }
  return rows;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Short or full git sha, or empty. Refuse placeholders.
const SHA_OR_EMPTY = /^(?:[0-9a-f]{7,40})?$/i;

describe("RELEASES.md published column (core#126)", () => {
  const md = readFileSync(RELEASES_PATH, "utf8");
  const rows = parseLedger(md);

  it("parses at least one ledger row (canary: table still present)", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("procedure forbids seeding published as the literal pending", () => {
    // Empty cell = not closed yet (honest). `pending` = pretence that someone checked.
    const bad = rows.filter((r) => /^pending$/i.test(r.published.trim()));
    expect(
      bad,
      bad.map((r) => `L${r.line} ${r.tag}: published=${JSON.stringify(r.published)}`).join("; ") ||
        "ok",
    ).toEqual([]);
  });

  it("procedure forbids seeding source commit as (this PR)", () => {
    // Same class of pretence: a placeholder that looks filled. Leave the cell empty until close.
    const bad = rows.filter((r) => /^\(this PR\)$/i.test(r.sourceCommit.trim()));
    expect(
      bad,
      bad.map((r) => `L${r.line} ${r.tag}: source=${JSON.stringify(r.sourceCommit)}`).join("; ") ||
        "ok",
    ).toEqual([]);
  });

  it("when published is filled, it is an ISO date (YYYY-MM-DD) from the registry close step", () => {
    const bad = rows.filter((r) => {
      const p = r.published.trim();
      return p.length > 0 && !ISO_DATE.test(p);
    });
    expect(
      bad,
      bad.map((r) => `L${r.line} ${r.tag}: published=${JSON.stringify(r.published)}`).join("; ") ||
        "ok",
    ).toEqual([]);
  });

  it("when source commit is filled, it is a git sha (not a free-form claim)", () => {
    const bad = rows.filter((r) => !SHA_OR_EMPTY.test(r.sourceCommit.trim()));
    expect(
      bad,
      bad
        .map((r) => `L${r.line} ${r.tag}: source=${JSON.stringify(r.sourceCommit)}`)
        .join("; ") || "ok",
    ).toEqual([]);
  });

  it("docs still name the two-moment seed/close procedure (core#126)", () => {
    // Mechanical refusal of pending is half the fix; the procedure text is the other half.
    // Keep these phrases so a drive-by edit cannot drop the rule while the test stays green.
    expect(md).toMatch(/Closing the row/i);
    expect(md).toMatch(/do not write `pending`/i);
    expect(md).toMatch(/Settle it at the registry/i);
  });

  // ----------------------------------------------------------------------------------------
  // core#209. THE CELL MUST RESOLVE, NOT MERELY LOOK LIKE A SHA.
  //
  // The assertions above check SHAPE: seven hex characters, an ISO date. That is what let two
  // different wrong values through in one hour while the suite stayed green:
  //
  //   1. `git ls-remote --tags` returns the tag ANNOTATION object, not the commit it points at.
  //      For vivijure-core-v1.13.0 those are dea7149f and 9cd62f20 -- both seven hex characters,
  //      and only the second is the commit that shipped.
  //   2. A real commit that is simply the WRONG one (the feature PR merge rather than the commit
  //      the tag points at), which is what nearly landed for v1.14.0.
  //
  // A third arrived through the `published` column: npm's `time` object is keyed by version, and
  // taking its FIRST value yields `created` -- the package's first-ever publish, a month early
  // for this release. Well-formed, ISO, green.
  //
  // So these assert RELATIONSHIPS rather than formats, which is the same distinction
  // tests/changelog-released-entries.test.ts draws (core#207): that guard asks whether a commit is
  // an ANCESTOR of a tag, this one asks whether a recorded value IS the tag's commit. Neither can
  // be satisfied by a well-formed string, and that is the point of both. If you are wondering why
  // two adjacent ledger/changelog guards look different, this is why -- one checks membership in a
  // history, the other identity of a single object.
  //
  // OFFLINE by construction, like the rest of this file: everything below is answerable from git.
  // The registry read stays a human step (RELEASES.md step 5), so CI does not go flaky on npm.
  describe("the recorded values RESOLVE (core#209)", () => {
    const git = (args: string, allowFail = false): string => {
      try {
        return execSync(`git ${args}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch (e) {
        if (allowFail) return "";
        throw e;
      }
    };
    /** The COMMIT a tag points at. `rev-list -n 1` peels an annotated tag; `rev-parse` does not. */
    const tagCommit = (tag: string): string => git(`rev-list -n 1 ${tag}`, true);
    const bare = (t: string) => t.replace(/`/g, "").trim();

    const filledSha = rows.filter((r) => r.sourceCommit.trim().length > 0);
    const filledPub = rows.filter((r) => r.published.trim().length > 0);

    // REFUSALS FIRST. Each is a state in which every claim below would pass while measuring
    // nothing, so none of them may be a silent skip.
    it("REFUSES on a shallow clone, which cannot resolve tags to commits", () => {
      expect(
        git("rev-parse --is-shallow-repository", true),
        "shallow clone: tags cannot be resolved, so this guard would pass vacuously. CI needs fetch-depth: 0.",
      ).toBe("false");
    });

    it("REFUSES when no release tags are visible", () => {
      const tags = git("tag --list vivijure-core-v*", true).split("\n").filter(Boolean);
      console.log(`  denominator: ${rows.length} ledger rows, ${filledSha.length} with a source commit, ` +
        `${filledPub.length} with a published date, ${tags.length} release tags visible`);
      expect(tags.length, "no vivijure-core-v* tags visible -- nothing to resolve against").toBeGreaterThan(0);
    });

    it("REFUSES when a filled row names a tag that does not resolve (never skipped)", () => {
      const unresolvable = filledSha
        .filter((r) => !tagCommit(bare(r.tag)))
        .map((r) => `L${r.line} ${r.tag}`);
      expect(
        unresolvable,
        "these rows record a source commit for a tag this repo cannot resolve, so the value is UNVERIFIABLE",
      ).toEqual([]);
    });

    // THE CLAIMS.
    it("every recorded source commit IS the commit its tag points at", () => {
      const bad: string[] = [];
      for (const r of filledSha) {
        const tag = bare(r.tag);
        const commit = tagCommit(tag);
        if (!commit) continue; // covered by the refusal above
        const recorded = r.sourceCommit.trim().toLowerCase();
        if (!commit.toLowerCase().startsWith(recorded)) {
          const annotated = git(`rev-parse ${tag}`, true);
          const hint = annotated.toLowerCase().startsWith(recorded)
            ? " (this is the tag ANNOTATION object, not the commit -- use `git rev-list -n 1 <tag>`)"
            : "";
          bad.push(`L${r.line} ${tag}: ledger=${recorded} but the tag points at ${commit.slice(0, 8)}${hint}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("no published date precedes the commit it claims to publish", () => {
      // Offline sanity that catches npm `time.created` being read instead of time[<version>]:
      // a package cannot have been published before the code existed.
      const bad: string[] = [];
      for (const r of filledPub) {
        const commit = tagCommit(bare(r.tag));
        if (!commit) continue;
        const committed = git(`log -1 --format=%cs ${commit}`, true);
        if (committed && r.published.trim() < committed) {
          bad.push(`L${r.line} ${r.tag}: published=${r.published.trim()} precedes its commit date ${committed}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("no published date is in the future", () => {
      const today = new Date().toISOString().slice(0, 10);
      const bad = filledPub
        .filter((r) => r.published.trim() > today)
        .map((r) => `L${r.line} ${r.tag}: published=${r.published.trim()} is after ${today}`);
      expect(bad).toEqual([]);
    });

    // CONTROLS, on the same predicates the claims use. Without these, every assertion above is
    // consistent with a resolver that returns nothing and a comparison that never runs.
    it("CONTROL: an annotated tag's annotation object and its commit really do differ here", () => {
      const tag = filledSha.map((r) => bare(r.tag)).find((t) => git(`cat-file -t ${t}`, true) === "tag");
      expect(tag, "no annotated tag found -- the trap this guard exists for cannot be demonstrated").toBeTruthy();
      const annotation = git(`rev-parse ${tag}`);
      const commit = tagCommit(tag as string);
      expect(annotation).not.toBe(commit);
      // ...and the annotation is exactly the kind of value the SHAPE check would have accepted.
      expect(SHA_OR_EMPTY.test(annotation.slice(0, 7))).toBe(true);
    });

    it("CONTROL: the resolver returns a real commit for a known tag, and empty for a fake one", () => {
      const tag = bare(filledSha[0].tag);
      expect(tagCommit(tag)).toMatch(/^[0-9a-f]{40}$/);
      expect(tagCommit("vivijure-core-v0.0.0-not-a-tag"), "a fake tag must resolve to nothing").toBe("");
    });

    it("CONTROL: the comparison rejects a wrong-but-well-formed commit", () => {
      const tag = bare(filledSha[0].tag);
      const commit = tagCommit(tag);
      const parent = git(`rev-parse ${commit}^`, true);
      expect(parent, "no parent -- the control cannot run").toBeTruthy();
      // The parent is a real commit, seven hex characters, and NOT the tagged one.
      expect(SHA_OR_EMPTY.test(parent.slice(0, 7))).toBe(true);
      expect(commit.startsWith(parent.slice(0, 7))).toBe(false);
    });
  });

  it("planted control: a pending cell would fail the pending filter", () => {
    const planted: LedgerRow = {
      line: 0,
      tag: "`vivijure-core-v0.0.0`",
      npm: "0.0.0",
      sourceCommit: "(this PR)",
      published: "pending",
    };
    expect(/^pending$/i.test(planted.published)).toBe(true);
    expect(/^\(this PR\)$/i.test(planted.sourceCommit)).toBe(true);
    expect(ISO_DATE.test(planted.published)).toBe(false);
    expect(SHA_OR_EMPTY.test(planted.sourceCommit)).toBe(false);
  });
});
