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
