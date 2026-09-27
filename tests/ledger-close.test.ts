import { describe, expect, it } from "vitest";
import {
  EXIT,
  compareVersions,
  decideClose,
  deriveNewestServed,
  fillRow,
  findUnclosedPublishedRows,
  isIsoDate,
  parseLedgerRows,
} from "../scripts/ledger-close.mjs";

// core#318: the derive-and-guard half of closing a ledger row.
//
// WHAT THIS SUITE IS ACTUALLY FOR. Eleven of 47 rows have never been closed, and RELEASES.md's own
// text says the row "is written in TWO moments against TWO different pieces of evidence, and only
// the first has ever been reliable." The temptation is a hand backfill, and the thing that makes a
// backfill WORSE than the empty cells is that eleven rows filled with plausible unverifiable values
// read exactly like eleven rows filled with correct ones. So every test below is built around one
// question: does the script READ its two values, or produce something that merely looks right?
//
// EXIT CODES ARE ASSERTED SPECIFICALLY, never merely "non-zero". A refusal that cannot be
// distinguished from a failure stops being information, and the whole design rests on ONE refusal
// being distinguishable: "not published yet" is a third state, not an error.

/** The v1.21.8 row, in its real open shape, taken from `main`. */
const OPEN_ROW_1218 =
  "| `vivijure-core-v1.21.8` | 1.21.8 |  |  | **PATCH.** Cast voice sample rides motion. |";

/** A closed row, for the control that the guard does not flag it. */
const CLOSED_ROW_1240 =
  "| `vivijure-core-v1.24.0` | 1.24.0 | 832e823 | 2026-09-27 | **MINOR.** Two additive changes. |";

const LEDGER = [
  "| git tag | npm | source commit | published | notes |",
  "|---|---|---|---|---|",
  CLOSED_ROW_1240,
  OPEN_ROW_1218,
].join("\n");

// core#279 gathered these independently while hand-closing the row, and they are carried on core#318
// precisely so this suite can use them: a row whose correct values are already known is the only
// positive control that proves the script reads the registry rather than inventing a plausible date.
const FIXTURE_1218 = { tagCommit: "8dc0858abcdef0123456789", registryIso: "2026-08-18T00:21:30.473Z" };

describe("core#318 parsing", () => {
  it("parses both rows and reports empty cells as empty, not as missing rows", () => {
    const rows = parseLedgerRows(LEDGER);
    expect(rows.map((r) => r.version)).toEqual(["1.24.0", "1.21.8"]);
    expect(rows[1].sourceCommit).toBe("");
    expect(rows[1].published).toBe("");
    expect(rows[0].sourceCommit).toBe("832e823");
  });

  it("CANARY: the parser is not vacuous -- it finds nothing in a table with no ledger rows", () => {
    expect(parseLedgerRows("| a | b |\n|---|---|\n| x | y |")).toEqual([]);
  });
});

describe("core#318 the POSITIVE CONTROL: it uses what the readers returned", () => {
  it("closes v1.21.8 to core#279's independently known values", () => {
    const row = parseLedgerRows(LEDGER).find((r) => r.version === "1.21.8");
    const d = decideClose({ row, ...FIXTURE_1218 });
    expect(d.action).toBe("close");
    expect(d.exit).toBe(EXIT.ok);
    expect(d.sourceCommit).toBe("8dc0858");
    expect(d.published).toBe("2026-08-18");
  });

  it("a DIFFERENT registry date produces a DIFFERENT row, which is what proves it reads", () => {
    // The assertion the whole design turns on. If the script were inventing a date -- today's, or the
    // tag's -- this row would be unchanged by varying the registry's answer. Eleven rows filled with
    // a plausible invented date would be worse than eleven empty ones, because empty is honest.
    const row = parseLedgerRows(LEDGER).find((r) => r.version === "1.21.8");
    const a = decideClose({ row, tagCommit: FIXTURE_1218.tagCommit, registryIso: "2026-08-18T00:21:30.473Z" });
    const b = decideClose({ row, tagCommit: FIXTURE_1218.tagCommit, registryIso: "2019-01-02T03:04:05.000Z" });
    expect(a.published).toBe("2026-08-18");
    expect(b.published).toBe("2019-01-02");
    expect(a.published).not.toBe(b.published);
  });

  it("the commit comes from the TAG reader, so a different tag commit lands in the row", () => {
    const row = parseLedgerRows(LEDGER).find((r) => r.version === "1.21.8");
    const d = decideClose({ row, tagCommit: "deadbee1234567890", registryIso: FIXTURE_1218.registryIso });
    expect(d.sourceCommit).toBe("deadbee");
  });
});

describe("core#318 NOT PUBLISHED YET is a THIRD state, with its own exit code", () => {
  it("refuses with exit 2 and says it is the absent-version window, not a failure", () => {
    const row = parseLedgerRows(LEDGER).find((r) => r.version === "1.21.8");
    const d = decideClose({ row, tagCommit: FIXTURE_1218.tagCommit, registryIso: null });
    expect(d.action).toBe("refuse");
    // Asserted SPECIFICALLY. "not zero" would pass for every other refusal and lose the distinction.
    expect(d.exit).toBe(EXIT.notPublishedYet);
    expect(d.exit).not.toBe(EXIT.tagUnresolved);
    expect(d.exit).not.toBe(EXIT.badRegistryDate);
    expect(d.reason).toContain("NOT A FAILED PUBLISH");
  });

  it("every refusal has a DISTINCT code, so no two collapse into each other", () => {
    const row = parseLedgerRows(LEDGER).find((r) => r.version === "1.21.8");
    const codes = [
      decideClose({ row, tagCommit: null, registryIso: FIXTURE_1218.registryIso }).exit,
      decideClose({ row, tagCommit: FIXTURE_1218.tagCommit, registryIso: null }).exit,
      decideClose({ row, tagCommit: FIXTURE_1218.tagCommit, registryIso: "not-a-date" }).exit,
      decideClose({ row: null, tagCommit: null, registryIso: null }).exit,
    ];
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([EXIT.tagUnresolved, EXIT.notPublishedYet, EXIT.badRegistryDate, EXIT.rowNotFound]);
  });

  it("an already-closed row is idempotent, exit 0, and is NOT rewritten", () => {
    const row = parseLedgerRows(LEDGER).find((r) => r.version === "1.24.0");
    const d = decideClose({ row, tagCommit: "ffffff1", registryIso: "2030-01-01T00:00:00.000Z" });
    expect(d.action).toBe("already-closed");
    expect(d.exit).toBe(EXIT.ok);
    expect(d.published).toBeUndefined();
  });
});

describe("core#318 the GUARD must not fire on a version that is genuinely unpublished", () => {
  const rows = parseLedgerRows(LEDGER);

  it("FIRES on a row left open on a version the registry IS serving", () => {
    const open = findUnclosedPublishedRows(rows, ["1.24.0", "1.21.8"]);
    expect(open.map((r: { version: string }) => r.version)).toEqual(["1.21.8"]);
  });

  it("does NOT fire when that version is absent from the registry (the hard case)", () => {
    // The two-states-as-one defect this guard exists to avoid being: "published, cells empty" and
    // "not published" must not render the same. An unpublished row is CORRECTLY open.
    const open = findUnclosedPublishedRows(rows, ["1.24.0"]);
    expect(open).toEqual([]);
  });

  it("CONTROL: a fully closed row is never flagged, so the guard is not refusing everything", () => {
    const closedOnly = parseLedgerRows([LEDGER.split("\n")[0], LEDGER.split("\n")[1], CLOSED_ROW_1240].join("\n"));
    expect(findUnclosedPublishedRows(closedOnly, ["1.24.0"])).toEqual([]);
  });

  it("an EMPTY registry answer flags nothing, rather than flagging everything", () => {
    // A network failure returns {} from the reader. Flagging all 47 rows on an unreachable registry
    // would be a guard that fires on its own blindness.
    expect(findUnclosedPublishedRows(rows, [])).toEqual([]);
  });
});

describe("core#318 fillRow touches exactly two cells", () => {
  it("fills the two empty cells and leaves tag, npm and notes byte-identical", () => {
    const row = parseLedgerRows(LEDGER).find((r) => r.version === "1.21.8");
    const out = fillRow(LEDGER, row, "8dc0858", "2026-08-18");
    const after = parseLedgerRows(out).find((r) => r.version === "1.21.8");
    // Asserted rather than asserted-away: if the row vanished, every expectation below would be
    // vacuous on undefined, which is the shape this suite exists to refuse.
    expect(after).toBeDefined();
    expect(after?.sourceCommit).toBe("8dc0858");
    expect(after?.published).toBe("2026-08-18");
    expect(after?.npm).toBe("1.21.8");
    expect(after?.line).toContain("**PATCH.** Cast voice sample rides motion.");
    // and the sibling row is untouched
    expect(out).toContain(CLOSED_ROW_1240);
  });

  it("rejects a full timestamp where a date belongs", () => {
    expect(isIsoDate("2026-08-18")).toBe(true);
    expect(isIsoDate("2026-08-18T00:21:30.473Z")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });
});

describe("core#318 option 3: the exemption is DERIVED, and exactly one row wide", () => {
  // WHY AN EXEMPTION AT ALL. Between the publish and the close-row merge, main LEGITIMATELY has a
  // served version whose cells are empty. A guard firing then reddens unrelated PRs on every release,
  // and a gate that reddens for reasons unconnected to the change in front of it gets bypassed.
  const rows = parseLedgerRows(LEDGER);

  it("exempts the newest served version, so the release window is silent", () => {
    // 1.24.0 is the newest here and its row is closed; re-read the open one as if it were newest.
    const openNewest = parseLedgerRows(
      [LEDGER.split("\n")[0], LEDGER.split("\n")[1], "| `vivijure-core-v1.24.0` | 1.24.0 |  |  | x |", OPEN_ROW_1218].join("\n"),
    );
    expect(findUnclosedPublishedRows(openNewest, ["1.24.0", "1.21.8"], "1.24.0").map((r: { version: string }) => r.version))
      .toEqual(["1.21.8"]);
  });

  it("does NOT exempt an older served version, so the window is one row and not a hole", () => {
    // The failure mode an exemption invites: exempting more than it should. 1.21.8 is served and open
    // and is NOT the newest, so it must still fire even while 1.24.0 is exempt.
    const open = findUnclosedPublishedRows(rows, ["1.24.0", "1.21.8"], "1.24.0");
    expect(open.map((r: { version: string }) => r.version)).toEqual(["1.21.8"]);
  });

  it("exempting nothing is the same as before, so the exemption is additive", () => {
    expect(findUnclosedPublishedRows(rows, ["1.24.0", "1.21.8"], null).map((r: { version: string }) => r.version))
      .toEqual(["1.21.8"]);
  });
});

describe("core#318 the derive REFUSES rather than guessing, and says UNMEASURED", () => {
  it("two independent readings must AGREE, or the exemption is ambiguous", () => {
    // Legitimate divergence: a patch published to an older line does not move dist-tags.latest. In
    // that state "the newest served version" genuinely has two answers, so the guard picks neither.
    const d = deriveNewestServed(["1.24.0", "1.25.0"], "1.24.0");
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("disagree");
    expect(d.reason).toContain("AMBIGUOUS");
  });

  it("agreeing readings produce the version", () => {
    const d = deriveNewestServed(["1.23.0", "1.24.0", "1.25.0"], "1.25.0");
    expect(d.ok).toBe(true);
    expect(d.version).toBe("1.25.0");
  });

  it("an EMPTY served set is a failed read, not an empty world", () => {
    // THE NON-EMPTY ASSERTION. Returning a version here would exempt something arbitrary; returning
    // null silently would exempt nothing and fire on the legitimate window. Both read as working.
    const d = deriveNewestServed([], "1.25.0");
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("NO published versions");
  });

  it("an absent dist-tags.latest is a failed read, so there is nothing to cross-check against", () => {
    const d = deriveNewestServed(["1.24.0", "1.25.0"], null);
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("cross-check");
  });

  it("the UNMEASURED exit code is DISTINCT from found-open-rows", () => {
    // Asserted specifically: "could not measure" and "measured, and it is bad" must not collapse.
    expect(EXIT.guardUnmeasured).not.toBe(EXIT.guardFoundOpenRows);
    expect(EXIT.guardUnmeasured).not.toBe(EXIT.ok);
    expect(EXIT.guardUnmeasured).toBe(7);
  });
});

describe("core#318 compareVersions is numeric per segment", () => {
  it("1.10.0 is newer than 1.9.0, which a string sort gets wrong", () => {
    // The classic. A lexicographic sort would call 1.9.0 the newest and exempt the wrong row.
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(["1.9.0", "1.10.0", "1.8.0"].slice().sort(compareVersions).at(-1)).toBe("1.10.0");
  });

  it("derives the newest correctly across a double-digit minor", () => {
    const d = deriveNewestServed(["1.8.0", "1.9.0", "1.10.0"], "1.10.0");
    expect(d.ok).toBe(true);
    expect(d.version).toBe("1.10.0");
  });
});
