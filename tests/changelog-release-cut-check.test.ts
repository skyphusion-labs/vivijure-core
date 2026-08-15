// Drives scripts/changelog-release-cut-check.mjs (core#212 release-cut trigger). Fixtures use the
// EXACT open-PR cohort the lead measured live while attempting to cut v1.15.0: #199, #203, #207,
// #219 touch CHANGELOG.md directly; #220 does not. Real numbers rather than invented ones, so the
// fixture is grounded in a live case instead of a constructed one.
//
// Both directions asserted, per the leads own acceptance criterion: "close the heading with those
// four open, confirm it refuses; close it with none open, confirm it passes."

import { describe, expect, it } from "vitest";
import { checkOpenPrs, classifyPr } from "../scripts/changelog-release-cut-check.mjs";

const LIVE_COHORT = [
  { number: 199, files: ["CHANGELOG.md", "scripts/comment-symbol-refs.mjs"] },
  { number: 203, files: ["CHANGELOG.md", "src/film-model.ts", "src/film-orchestrator.ts"] },
  { number: 207, files: ["CHANGELOG.md", "tests/changelog-released-entries.test.ts"] },
  { number: 219, files: ["CHANGELOG.md"] },
  { number: 220, files: ["docs/CONTRACT.md"] },
];

describe("changelog-release-cut-check (core#212 release-cut trigger)", () => {
  it("REFUSES with the live cohort: exactly #199, #203, #207, #219 named, #220 excluded", () => {
    const result = checkOpenPrs(LIVE_COHORT);
    expect(result.ok).toBe(false);
    expect(result.atRisk).toEqual([199, 203, 207, 219]);
  });

  it("PASSES once none of the CHANGELOG.md-touching PRs are still open", () => {
    const drained = LIVE_COHORT.filter((pr) => pr.number === 220);
    const result = checkOpenPrs(drained);
    expect(result.ok).toBe(true);
    expect(result.atRisk).toEqual([]);
  });

  it("PASSES on an empty open-PR list (nothing to strand)", () => {
    expect(checkOpenPrs([])).toEqual({ ok: true, atRisk: [] });
  });

  it("a PR using ONLY a changelog.d/ fragment is not at risk (core#202/core#212 durable fix)", () => {
    const result = checkOpenPrs([{ number: 300, files: ["changelog.d/300-x.md", "src/a.ts"] }]);
    expect(result.ok).toBe(true);
  });

  it("mixed cohort: only the CHANGELOG.md-touching PR is named, the fragment PR is not", () => {
    const result = checkOpenPrs([
      { number: 1, files: ["changelog.d/1-x.md"] },
      { number: 2, files: ["CHANGELOG.md"] },
    ]);
    expect(result.atRisk).toEqual([2]);
  });

  it("a PR carrying BOTH a fragment and a direct CHANGELOG.md edit is still at risk", () => {
    // Legal during the migration window (entry-required accepts either), but a direct edit means
    // this PR still has a heading dependency regardless of the fragment also present.
    const result = checkOpenPrs([{ number: 3, files: ["changelog.d/3-x.md", "CHANGELOG.md"] }]);
    expect(result.ok).toBe(false);
    expect(result.atRisk).toEqual([3]);
  });

  it("classifyPr is exact: a file merely containing CHANGELOG.md as a substring does not match", () => {
    expect(classifyPr(["docs/CHANGELOG.md.bak"]).touchesChangelogDirect).toBe(false);
    expect(classifyPr(["CHANGELOG.md"]).touchesChangelogDirect).toBe(true);
  });

  it("atRisk is sorted ascending regardless of input order", () => {
    const result = checkOpenPrs([
      { number: 219, files: ["CHANGELOG.md"] },
      { number: 199, files: ["CHANGELOG.md"] },
      { number: 207, files: ["CHANGELOG.md"] },
    ]);
    expect(result.atRisk).toEqual([199, 207, 219]);
  });
});
