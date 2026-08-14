// Every entry under a RELEASED changelog heading must actually be in that release (core#202, and
// the cf#551 class). Sibling of tests/changelog-version.test.ts, which guards the HEADING; this
// guards the ENTRIES beneath it.
//
// WHY IT EXISTS. core#204 found three entries under the published `## [1.13.0]` naming work that
// merged after the tag was cut -- and while that PR sat open it acquired a FOURTH, because an
// unrelated merge (core#197) appended to the top released heading while `## Unreleased` was empty.
// The accrual is mechanical: one per merge that hand-edits the changelog in that state. Nothing in
// this repo could observe it. Measured 2026-08-14 across 179 tracked files, 7 workflows and 2
// scripts: `changelog-version.test.ts` guards the heading, and the only `merge-base --is-ancestor`
// anywhere was `publish-npm.yml:37` asserting a build commit is on main. So the class was caught
// twice by a human reading a table, which is not a control.
//
// WHAT IT ASSERTS. For each `## [X.Y.Z]` heading with a matching `vivijure-core-vX.Y.Z` tag, every
// `### ` entry beneath it must have been introduced by a commit that is an ANCESTOR of that tag.
//
// THE ONE LEGITIMATE EXCEPTION, and it is why this file is not simply an ancestry loop. An entry
// can postdate its tag for a GOOD reason: the work shipped and the entry was backfilled afterwards.
// That is documented practice here -- `63fd0bb7` added the v1.3.0 lip-sync entry ten minutes after
// the tag, and the entry says so in its own body ("this landed on main between 1.2.14 and 1.3.0
// without an entry of its own"). Its CODE was in the release; only the prose was late.
//
// A naive ancestry check calls that a defect. It is not, and a guard that manufactures defects is
// worse than one that misses them, because someone then "fixes" a correct record by deleting it.
// So a backfill is ALLOWED and must be DECLARED: the entry body carries a `Backfilled:` line with a
// reason. Prose is not a control; a greppable declaration is. Every accepted backfill is PRINTED on
// every run, so a silenced row is visible rather than invisible -- an exemption you cannot see is
// the thing this repo keeps paying for.
//
// REFUSALS ARE NOT PASSES. A shallow clone, missing tags, an unresolvable entry or a zero-row
// derivation all FAIL. This check runs on git history, and CI checks out shallow by default, so the
// most likely way for it to be useless is to quietly measure nothing.

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const TAG_PREFIX = "vivijure-core-v";

const git = (args: string, allowFail = false): string => {
  try {
    return execSync(`git ${args}`, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (allowFail) return "";
    throw e;
  }
};

const isAncestor = (a: string, b: string): boolean => {
  try {
    execSync(`git merge-base --is-ancestor ${a} ${b}`, { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

interface Section {
  version: string;
  tag: string;
  entries: { title: string; body: string }[];
}

/** Released sections and their entries. A section is RELEASED when a matching tag exists. */
function releasedSections(changelog: string, tags: Set<string>): Section[] {
  const lines = changelog.split("\n");
  const out: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^## \[?(\d+\.\d+\.\d+)\]?/.exec(lines[i]);
    if (!m) continue;
    const tag = TAG_PREFIX + m[1];
    if (!tags.has(tag)) continue; // not released yet: changelog-version.test.ts owns that case
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith("## ")) { end = j; break; }
    }
    const entries: { title: string; body: string }[] = [];
    for (let j = i + 1; j < end; j++) {
      if (!lines[j].startsWith("### ")) continue;
      let e = end;
      for (let k = j + 1; k < end; k++) {
        if (lines[k].startsWith("### ")) { e = k; break; }
      }
      entries.push({ title: lines[j].slice(4).trim(), body: lines.slice(j, e).join("\n") });
    }
    out.push({ version: m[1], tag, entries });
  }
  return out;
}

/** The oldest commit that introduced this entry's title into CHANGELOG.md. */
function introducingCommit(title: string): string | null {
  // Match on the title text, escaped for the shell. A 70-char slice keeps the -S needle away from
  // trailing punctuation that a later reword may have touched.
  const needle = title.slice(0, 70).replace(/'/g, "'\\''");
  const shas = git(`log --format=%H --diff-filter=AM -S'${needle}' -- CHANGELOG.md`, true)
    .split("\n").filter(Boolean);
  return shas.length ? shas[shas.length - 1] : null;
}

// The reason must be on the SAME LINE as the marker. `\s` matches newlines, so an earlier
// `\s*\S+` was satisfied by the CONTINUATION line of an otherwise-empty declaration:
//   - Backfilled:\n     ...indented prose...
// passed as a declared reason. `[^\S\n]` is horizontal whitespace only, so an empty marker
// stays empty. Found by measuring the condition rather than by reading the regex.
const BACKFILL_RE = /^[^\S\n]*[-*]?[^\S\n]*Backfilled:[^\S\n]*\S+/im;

describe("every entry under a released heading is IN that release (core#202)", () => {
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const tags = new Set(git("tag --list", true).split("\n").filter(Boolean));
  const sections = releasedSections(changelog, tags);

  // ---- REFUSALS. Each of these is a state in which the check below would pass while measuring
  // nothing, so each is asserted BEFORE any ancestry claim is made.

  it("REFUSES on a shallow clone, which cannot answer an ancestry question", () => {
    const shallow = git("rev-parse --is-shallow-repository", true);
    expect(
      shallow,
      "shallow clone: merge-base cannot see the history this check depends on. " +
        "CI must check out with fetch-depth: 0 (and fetch-tags), or this guard measures nothing.",
    ).toBe("false");
  });

  it("REFUSES when no release tags are present", () => {
    // fetch-tags can be true while depth is 1; tags present is a separate fact from history depth.
    const releaseTags = [...tags].filter((t) => t.startsWith(TAG_PREFIX));
    console.log(`  denominator: ${tags.size} tags visible, ${releaseTags.length} release tags`);
    expect(releaseTags.length, "no vivijure-core-v* tags visible -- nothing to check against").toBeGreaterThan(0);
  });

  it("REFUSES on a zero-row derivation", () => {
    const entries = sections.reduce((n, s) => n + s.entries.length, 0);
    console.log(
      `  denominator: ${sections.length} released sections, ${entries} entries examined`,
    );
    expect(sections.length, "no released sections parsed from CHANGELOG.md -- the parser found nothing").toBeGreaterThan(0);
    expect(entries, "released sections parsed but ZERO entries in them -- the entry matcher found nothing").toBeGreaterThan(0);
  });

  // ---- THE CLAIM.

  it("every entry resolves to a commit (an unresolvable entry is UNMEASURED, never a pass)", () => {
    const unresolved: string[] = [];
    for (const s of sections) {
      for (const e of s.entries) {
        if (!introducingCommit(e.title)) unresolved.push(`${s.version}: ${e.title.slice(0, 60)}`);
      }
    }
    expect(unresolved, "these entries could not be traced to a commit, so their ancestry is unknown").toEqual([]);
  });

  it("no entry under a released heading postdates its own tag, unless declared a backfill", () => {
    const violations: string[] = [];
    const backfills: string[] = [];
    for (const s of sections) {
      for (const e of s.entries) {
        const sha = introducingCommit(e.title);
        if (!sha) continue; // covered by the test above
        if (isAncestor(sha, s.tag)) continue;
        if (BACKFILL_RE.test(e.body)) {
          backfills.push(`${s.version} ${sha.slice(0, 8)} ${e.title.slice(0, 58)}`);
          continue;
        }
        violations.push(
          `${s.version}: "${e.title.slice(0, 70)}" was introduced by ${sha.slice(0, 8)}, ` +
            `which is NOT an ancestor of ${s.tag}. Either move it to ## Unreleased, or -- if the ` +
            `WORK shipped in that release and only the entry was late -- add a "Backfilled: <why>" ` +
            `line to the entry body.`,
        );
      }
    }
    // Accepted exemptions are PRINTED on every run. An exemption nobody can see is how a control
    // gets switched off permanently by accident.
    console.log(`  declared backfills accepted: ${backfills.length}`);
    for (const b of backfills) console.log(`    BACKFILL ${b}`);
    expect(violations).toEqual([]);
  });

  // ---- POSITIVE CONTROLS, on the same predicates the real checks use (the reconstructed-defect
  // standard this repo's sibling guard already holds itself to). Without these, every assertion
  // above is consistent with a parser that finds nothing and a matcher that matches nothing.

  it("CONTROL: the section parser finds entries in a known-populated changelog", () => {
    const planted = [
      "## [9.9.9] -- 2026-01-01",
      "",
      "### Fixed: a planted entry",
      "",
      "- body",
      "",
      "## [9.9.8] -- 2026-01-01",
      "",
      "### Fixed: another planted entry",
      "",
    ].join("\n");
    const parsed = releasedSections(planted, new Set(["vivijure-core-v9.9.9", "vivijure-core-v9.9.8"]));
    expect(parsed.map((s) => s.version)).toEqual(["9.9.9", "9.9.8"]);
    expect(parsed[0].entries.map((e) => e.title)).toEqual(["Fixed: a planted entry"]);
  });

  it("CONTROL: an untagged section is NOT treated as released", () => {
    const planted = "## Unreleased / v9.9.9\n\n### Fixed: not released yet\n";
    expect(releasedSections(planted, new Set())).toEqual([]);
  });

  it("CONTROL: the backfill matcher accepts a declared backfill and rejects mere prose", () => {
    expect(BACKFILL_RE.test("### x\n\n- Backfilled: the code shipped in the tag, the entry was late.")).toBe(true);
    expect(BACKFILL_RE.test("### x\n\nBackfilled: shipped without an entry of its own")).toBe(true);
    // Prose ABOUT backfilling is not a declaration, and an empty reason is not one either.
    expect(BACKFILL_RE.test("### x\n\n- this was backfilled at some point")).toBe(false);
    expect(BACKFILL_RE.test("### x\n\n- Backfilled:")).toBe(false);
    // THE SHAPE THAT ACTUALLY OCCURS, and the one the fixture above could not produce: an empty
    // marker whose bullet CONTINUES on the next line. `\s` spans newlines, so a reason-less
    // declaration was previously satisfied by its own continuation text. A fixture with nothing
    // after the colon cannot reach that path, which is why this case is stated separately.
    expect(BACKFILL_RE.test("### x\n\n- Backfilled:\n  continuation prose, not a reason")).toBe(false);
    expect(BACKFILL_RE.test("### x\n\n- Backfilled:   \n  continuation prose")).toBe(false);
    // ...and a real same-line reason still passes, so the tightening did not break the escape.
    expect(BACKFILL_RE.test("### x\n\n- Backfilled: the code shipped; only the entry was late.\n  more")).toBe(true);
  });

  it("CONTROL: isAncestor can return BOTH answers on this repo", () => {
    const head = git("rev-parse HEAD");
    expect(isAncestor(head, head), "a commit must be an ancestor of itself").toBe(true);
    // The NO answer needs an ancestor of HEAD that is not HEAD. An earlier version of this control
    // used the ROOT commit, which is wrong in exactly the environment that matters: in a truncated
    // checkout HEAD *is* the root, so the control asserted something false about a working
    // predicate and read as a defect in the subject. Found by this file's own PR CI on the coverage
    // job. Use HEAD's parent, and REFUSE when there is none rather than passing -- no parent means
    // the history this whole file depends on is absent, which is the shallow case by another route.
    const parent = git("rev-parse --verify -q HEAD^", true);
    expect(
      parent,
      "HEAD has no parent, so the history this check needs is absent -- see the shallow-clone refusal",
    ).toBeTruthy();
    expect(isAncestor(head, parent), "HEAD must NOT be an ancestor of its own parent").toBe(false);
  });
});
