#!/usr/bin/env node
// Close a RELEASES.md ledger row by DERIVING both cells, and a guard that refuses a row left open on
// a version the registry is already serving (core#318).
//
// WHY A SCRIPT AND A GUARD RATHER THAN A BACKFILL. RELEASES.md calls closing the row "step 5, and the
// one that gets skipped", and it is skipped on 11 of 47 rows -- 23%. Its own text says the row "is
// written in TWO moments against TWO different pieces of evidence, and only the first has ever been
// reliable." A hand backfill closes today and changes nothing about the next cut, because the step
// sits AFTER the publish, which is after the part that feels like the release is over.
//
// THE TWO CELLS COME FROM DIFFERENT PLACES AND THAT IS THE POINT:
//   * `source commit` is the commit the TAG points at -- not HEAD, which has usually moved on;
//   * `published` is the date THE REGISTRY reports -- not a local clock, and not when the tag was
//     pushed. The push is our action; the publish is the registry's fact, and only one of them is
//     what the column claims.
//
// THE HARD CASE THIS IS BUILT AROUND: a version that is not published YET.
//
// RELEASES.md documents that a fresh publish answers a confident E404 for MINUTES, with
// `dist-tags.latest` still reading the previous version, and that a direct registry fetch reports it
// absent too, so bypassing npm's cache rules nothing out. Measured across three cuts: ~2 min
// (v1.23.0), ~20 s (v1.24.0), ~2 min 40 s (v1.25.0). The window is not converging.
//
// So "the registry has no time for this version" is a THIRD state, distinct from both success and
// failure, and it gets its own exit code with a message that says so. A tool that collapsed it into
// an error would train its operator to ignore the error; a tool that collapsed it into success would
// invent a date. **A guard that cannot tell "published, cells empty" from "not published" is the
// two-states-as-one defect, inside the tool built to fix a record-keeping defect.**
//
// EXIT CODES ARE PART OF THE CONTRACT, not diagnostics. Callers and tests assert on them
// specifically, because "refuses" collapsing into "failed" is how a refusal stops being information.
//   0  closed, or already closed (idempotent)
//   2  NOT PUBLISHED YET -- the absent-version window. Not an error. Re-run later.
//   3  the tag does not resolve to a commit
//   4  no such row, or more than one
//   5  the registry answered with something that is not an ISO date
//   6  guard mode: at least one row is open on a version the registry IS serving
//
// IO IS INJECTED, one seam each, so the pure decision logic is testable without a network and
// without a git tree -- and so a test can feed a DELIBERATELY DIFFERENT date and prove the row
// carries what the reader returned rather than something the script invented.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export const EXIT = {
  ok: 0,
  notPublishedYet: 2,
  tagUnresolved: 3,
  rowNotFound: 4,
  badRegistryDate: 5,
  guardFoundOpenRows: 6,
  /** The exemption could not be DERIVED. Reported as UNMEASURED, never guessed. */
  guardUnmeasured: 7,
};

export const PACKAGE = "@skyphusion-labs/vivijure-core";
const TAG_PREFIX = "vivijure-core-v";

/** One ledger row, as parsed. `sourceCommit` / `published` are "" when the cell is empty. */
export function parseLedgerRows(markdown) {
  const rows = [];
  for (const line of String(markdown).split("\n")) {
    const m = /^\|\s*`(vivijure-core-v([0-9][^`]*))`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line);
    if (!m) continue;
    rows.push({
      line,
      tag: m[1],
      version: m[2],
      npm: m[3].trim(),
      sourceCommit: m[4].trim(),
      published: m[5].trim(),
    });
  }
  return rows;
}

/** An ISO date, exactly. Rejects a full timestamp, so a caller cannot pass one through by accident. */
export function isIsoDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * The decision, pure. Returns `{ action, exit, reason?, sourceCommit?, published? }`.
 *
 * Deliberately takes the already-read values rather than reading them, so the caller owns IO and a
 * test can vary either one independently.
 */
export function decideClose({ row, tagCommit, registryIso }) {
  if (!row) return { action: "refuse", exit: EXIT.rowNotFound, reason: "no ledger row for that version" };
  if (row.sourceCommit && row.published) {
    return { action: "already-closed", exit: EXIT.ok, reason: "row already closed; refusing to rewrite it" };
  }
  if (!tagCommit) {
    return { action: "refuse", exit: EXIT.tagUnresolved, reason: `cannot resolve ${row.tag} to a commit` };
  }
  if (!registryIso) {
    return {
      action: "refuse",
      exit: EXIT.notPublishedYet,
      reason:
        `the registry reports no publish time for ${row.version} yet. This is the ABSENT-VERSION ` +
        "WINDOW, NOT A FAILED PUBLISH: a fresh publish answers a confident E404 for minutes and a " +
        "cache bypass does not rule it out. Confirm via the publish step log, then re-run.",
    };
  }
  const published = String(registryIso).slice(0, 10);
  if (!isIsoDate(published)) {
    return { action: "refuse", exit: EXIT.badRegistryDate, reason: `registry timestamp ${registryIso} is not an ISO date` };
  }
  return { action: "close", exit: EXIT.ok, sourceCommit: String(tagCommit).slice(0, 7), published };
}

/** Rewrite exactly one row's two empty cells. Never touches any other row or column. */
export function fillRow(markdown, row, sourceCommit, published) {
  const before = row.line;
  const after = before.replace(
    /^(\|\s*`[^`]+`\s*\|[^|]*\|)([^|]*)\|([^|]*)\|/,
    (_all, head) => `${head} ${sourceCommit} | ${published} |`,
  );
  if (after === before) throw new Error("fillRow made no change; the row shape is not what was parsed");
  const out = String(markdown).split("\n");
  const idx = out.indexOf(before);
  if (idx < 0) throw new Error("fillRow could not locate the row it parsed");
  if (out.indexOf(before, idx + 1) >= 0) throw new Error("fillRow found the row twice; refusing to guess");
  out[idx] = after;
  return out.join("\n");
}

/**
 * GUARD: rows left open on a version the registry IS serving.
 *
 * `publishedVersions` is the set the registry reports. A version ABSENT from it is NOT reported --
 * that is the whole point, and it is why this takes a set rather than calling the registry per row.
 */
/**
 * @param {ReturnType<typeof parseLedgerRows>} rows
 * @param {readonly string[]} publishedVersions
 * @param {string|null} [exemptVersion] the single newest SERVED version, DERIVED never configured
 */
export function findUnclosedPublishedRows(rows, publishedVersions, exemptVersion = null) {
  const serving = new Set(publishedVersions);
  return rows.filter(
    (r) => serving.has(r.version) && r.version !== exemptVersion && !(r.sourceCommit && r.published),
  );
}

/** Compare two dotted versions. Numeric per segment, so 1.10.0 sorts above 1.9.0. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10));
  const pb = String(b).split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * DERIVE the single newest served version. Never configured, and never guessed.
 *
 * WHY THE EXEMPTION EXISTS (core#318 option 3). Between the publish and the close-row merge, `main`
 * LEGITIMATELY has a served version whose cells are still empty. A guard that fired then would redden
 * unrelated PRs during every release window, and a gate that reddens for reasons unconnected to the
 * change in front of it is on the bypass list within a month. So exactly one row is exempt: the newest
 * served version, for exactly as long as it is the newest.
 *
 * WHY IT IS DERIVED AND NOT LISTED. A hardcoded exempt version is a passthrough echo waiting to
 * happen: it would exempt the wrong row forever the moment a release lands and nobody edits it.
 *
 * TWO INDEPENDENT READINGS, AND A DISAGREEMENT IS UNMEASURED RATHER THAN A PICK. The max of the full
 * published set and the registry's own `dist-tags.latest` are computed separately and must agree. They
 * can differ legitimately (a patch published to an older line does not move `latest`), and in that case
 * "the newest served version" is genuinely ambiguous -- so the guard says so and exits non-zero rather
 * than exempting the wrong row or none.
 *
 * THE NON-EMPTY ASSERTION IS THE POINT. An empty served set, or an absent `latest`, is a FAILED READ
 * and not an empty world. Returning null for it would exempt nothing (and fire on the legitimate
 * window) or, compared the other way, exempt everything. Both read as working, which is the defect
 * this whole issue is about.
 */
export function deriveNewestServed(publishedVersions, distTagLatest) {
  const versions = [...new Set((publishedVersions || []).filter(Boolean))];
  if (!versions.length) {
    return { ok: false, reason: "the registry reported NO published versions; the read failed rather than the world being empty" };
  }
  if (!distTagLatest) {
    return { ok: false, reason: "the registry reported no dist-tags.latest; cannot cross-check the newest served version" };
  }
  const maxOfAll = versions.slice().sort(compareVersions).at(-1);
  if (maxOfAll !== distTagLatest) {
    return {
      ok: false,
      reason:
        `two independent readings disagree on the newest served version: max(versions)=${maxOfAll} ` +
        `but dist-tags.latest=${distTagLatest}. That is legitimate when a patch lands on an older ` +
        "line, and it means the exemption is AMBIGUOUS. Refusing to pick one.",
    };
  }
  return { ok: true, version: maxOfAll };
}

// ---------------------------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------------------------

export function readTagCommit(tag, cwd) {
  try {
    return execFileSync("git", ["rev-list", "-n1", tag], { cwd, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function readDistTagLatest() {
  try {
    const raw = execFileSync("npm", ["view", PACKAGE, "dist-tags.latest"], { encoding: "utf8" });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export function readRegistryTimes() {
  try {
    const raw = execFileSync("npm", ["view", PACKAGE, "time", "--json"], { encoding: "utf8" });
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function main(argv) {
  const ledgerPath = process.env.LEDGER_PATH || "RELEASES.md";
  const guard = argv.includes("--check");
  const markdown = readFileSync(ledgerPath, "utf8");
  const rows = parseLedgerRows(markdown);

  if (guard) {
    const times = readRegistryTimes();
    // The served set comes from the registry's own version list, not from the ledger, so a row the
    // ledger does not mention cannot influence what counts as served.
    const served = Object.keys(times).filter((k) => /^\d/.test(k));
    const newest = deriveNewestServed(served, readDistTagLatest());
    if (!newest.ok) {
      console.error(`ledger-close --check: UNMEASURED -- ${newest.reason}`);
      return EXIT.guardUnmeasured;
    }
    const open = findUnclosedPublishedRows(rows, served, newest.version);
    if (open.length) {
      console.error(
        `ledger-close --check: ${open.length} row(s) are OPEN on a version the registry is already ` +
          "serving. Run `node scripts/ledger-close.mjs <version>` for each:",
      );
      for (const r of open) console.error(`  ${r.version}`);
      return EXIT.guardFoundOpenRows;
    }
    console.log(
      `ledger-close --check: OK. ${rows.length} row(s) examined, none open on a served version ` +
        `(newest served ${newest.version} is exempt while it is newest).`,
    );
    return EXIT.ok;
  }

  const version = argv.find((a) => !a.startsWith("-"));
  if (!version) {
    console.error("usage: ledger-close.mjs <version> | --check");
    return EXIT.rowNotFound;
  }
  const matching = rows.filter((r) => r.version === version);
  if (matching.length !== 1) {
    console.error(`ledger-close: found ${matching.length} rows for ${version}; expected exactly 1`);
    return EXIT.rowNotFound;
  }
  const row = matching[0];
  const d = decideClose({
    row,
    tagCommit: readTagCommit(TAG_PREFIX + version, process.cwd()),
    registryIso: readRegistryTimes()[version] || null,
  });
  if (d.action === "already-closed") {
    console.log(`ledger-close: ${d.reason}`);
    return d.exit;
  }
  if (d.action === "refuse") {
    console.error(`ledger-close: REFUSE (exit ${d.exit}) -- ${d.reason}`);
    return d.exit;
  }
  writeFileSync(ledgerPath, fillRow(markdown, row, d.sourceCommit, d.published), "utf8");
  console.log(`ledger-close: ${row.tag} closed -- source commit ${d.sourceCommit}, published ${d.published}`);
  return EXIT.ok;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
