#!/usr/bin/env node
// core#183: detect comments in src/ that name a CONSUMER-SIDE FILE which exists in no live consumer.
//
// WHY THIS CLASS. A census of core's comments (core#183) measured 1424 comment blocks, 650 of which
// make a falsifiable claim about another component, and found 7 measurably false. Verifying a claim
// costs a human read; verifying that a NAMED FILE still exists costs a filesystem lookup. So this is
// the one axis of that census worth automating, and it was the highest yield per unit cost by a wide
// margin.
//
// WHAT IT DETECTS, stated narrowly on purpose: "a comment names `<something>.py` and no live
// consumer repo contains a file by that name". That is a STALE REFERENCE. It is a superset of the
// false-claim class and not the same thing -- a stale name can sit above a perfectly true sentence,
// and the census counted 8 such comments separately for exactly that reason. This tool does not
// claim a flagged comment is WRONG, only that it points at something that is gone.
//
// WHAT IT DOES NOT DETECT, so nobody mistakes green for coverage:
//   - dotted symbol references (`r2_io.download_and_extract`). The census's own regex missed
//     `characters.slot_image_path` because it required a trailing `(`, and a looser form matches
//     ordinary property access (`job.phase`, `env.DB`) at a noise level that would get this switched
//     off. A guard that fires on correct code is a guard people disable.
//   - claims naming no file and no symbol at all ("this is ignored downstream").
//   - whether a claim is TRUE. Only whether the file it names still exists.
//   - anything outside `src/`: tests and *.md are not scanned.
//
// FAILURE POSTURE. If no consumer root resolves, this REFUSES (exit 2) rather than reporting a clean
// sweep. A detector that silently stops matching reads as a clean repo, which is the exact defect
// this exists to catch.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const SRC_DIR = process.env.VIVIJURE_SYMREF_SRC ?? "src";
const EXCLUDE_DIRS = new Set([".git", "node_modules", "docs", "dist", "bundle-out", ".venv", "__pycache__"]);

// Two-way control, run on EVERY invocation before any verdict is trusted. POSITIVE must be found or
// the resolver is blind; NEGATIVE must not be, or the resolver matches anything. Either failing
// makes every result below meaningless, so both are checked first and both abort.
const CONTROL_PRESENT = "handler.py";
const CONTROL_ABSENT = "zzz_not_a_real_module_control.py";

function walk(dir, pred, out = []) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

/** Comment blocks only. String/template context is skipped so a filename inside a string literal
 *  (an error message, a key) is not mistaken for a comment claim. */
function commentBlocks(src) {
  const out = [];
  let i = 0;
  let inString = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inString) {
      if (c === "\\") { i += 2; continue; }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; i += 1; continue; }
    if (c === "/" && n === "/") {
      const e = src.indexOf("\n", i);
      const end = e === -1 ? src.length : e;
      out.push([i, src.slice(i, end)]);
      i = end;
      continue;
    }
    if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i);
      const end = e === -1 ? src.length : e + 2;
      out.push([i, src.slice(i, end)]);
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

const PY_REF = /\b([a-z_][a-z0-9_]{1,})\.py\b/g;

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

/** Declared roots and which of them actually exist, kept SEPARATE on purpose. Reporting only the
 *  resolved ones would let a checkout that silently stopped working narrow coverage while the run
 *  still read clean -- five of six consumers is not "clean", it is "measured less than it claimed". */
function consumerRoots() {
  const raw = process.env.VIVIJURE_CONSUMER_ROOTS ?? process.argv.slice(2).join(":");
  const declared = raw.split(":").map((s) => s.trim()).filter(Boolean);
  const resolved = declared.filter((p) => existsSync(p));
  return { declared, resolved, missing: declared.filter((p) => !existsSync(p)) };
}

function indexConsumers(roots) {
  const names = new Set();
  for (const root of roots) {
    for (const f of walk(root, (p) => p.endsWith(".py"))) names.add(basename(f));
  }
  return names;
}

function loadExclusions() {
  const p = process.env.VIVIJURE_SYMREF_EXCLUSIONS ?? "scripts/comment-symbol-refs.exclusions.json";
  if (!existsSync(p)) return [];
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  for (const e of parsed) {
    // An exclusion without a stated reason is a silent gap, and the next reader cannot tell a
    // decision from an oversight. An exclusion without an expected COUNT is worse: it would absorb
    // every future reference to that symbol, so the guard would quietly stop covering the thing it
    // was calibrated around.
    if (!e.symbol || !e.reason || typeof e.expected !== "number") {
      console.error(
        `REFUSED: exclusion ${JSON.stringify(e)} is missing a symbol, a reason, or an expected count.`,
      );
      process.exit(2);
    }
  }
  return parsed;
}

function main() {
  const { declared, resolved, missing } = consumerRoots();
  console.log(`consumer roots: ${resolved.length} resolved of ${declared.length} declared`);
  for (const r of resolved) console.log(`  OK      ${r}`);
  for (const r of missing) console.log(`  MISSING ${r}`);
  if (declared.length === 0) {
    console.error(
      "REFUSED: no consumer root was declared, so nothing could be checked.\n" +
        "  Pass roots via VIVIJURE_CONSUMER_ROOTS (colon-separated) or as arguments.\n" +
        "  This exits non-zero ON PURPOSE: a sweep with nothing to sweep must not read as clean.",
    );
    process.exit(2);
  }
  if (missing.length) {
    console.error(
      `REFUSED: ${missing.length} declared consumer root(s) do not exist, so this run would have\n` +
        "  checked a NARROWER set than it was configured for and reported the same green either way.\n" +
        "  Fix the checkout, or remove the root deliberately.",
    );
    process.exit(2);
  }

  const present = indexConsumers(resolved);
  console.log(`consumer .py files indexed: ${present.size}`);

  // CONTROL FIRST, in the same run as the claim, before any finding is trusted.
  const posOk = present.has(CONTROL_PRESENT);
  const negOk = !present.has(CONTROL_ABSENT);
  console.log(`CONTROL positive (${CONTROL_PRESENT} must resolve):  ${posOk ? "PASS" : "FAIL"}`);
  console.log(`CONTROL negative (${CONTROL_ABSENT} must not):       ${negOk ? "PASS" : "FAIL"}`);
  if (!posOk || !negOk) {
    console.error("REFUSED: the two-way control did not pass, so this run measured the instrument, not the tree.");
    process.exit(2);
  }

  const exclusions = loadExclusions();
  const excluded = new Map(exclusions.map((e) => [e.symbol, e.reason]));

  const files = walk(SRC_DIR, (p) => p.endsWith(".ts"));
  const findings = [];
  const skipped = [];
  let refs = 0;

  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const [offset, block] of commentBlocks(src)) {
      for (const m of block.matchAll(PY_REF)) {
        refs += 1;
        const sym = m[0];
        if (present.has(sym)) continue;
        const row = { file: f, line: lineOf(src, offset), symbol: sym };
        if (excluded.has(sym)) skipped.push({ ...row, reason: excluded.get(sym) });
        else findings.push(row);
      }
    }
  }

  console.log(`src files scanned: ${files.length}`);
  console.log(`consumer-file references found in comments: ${refs}`);
  console.log(`declared exclusions: ${exclusions.length} (matched ${skipped.length} references)`);
  for (const s of skipped) console.log(`  EXCLUDED ${s.symbol} at ${s.file}:${s.line} -- ${s.reason}`);

  // An excluded symbol is excused for a KNOWN set of references, not forever. If a new comment names
  // an already-excluded file, the count moves and this trips -- otherwise the exclusion list would
  // grow coverage holes silently, which is the failure mode of every allowlist.
  const drift = [];
  for (const e of exclusions) {
    const actual = skipped.filter((s) => s.symbol === e.symbol).length;
    if (actual !== e.expected) drift.push(`${e.symbol}: expected ${e.expected} excluded references, found ${actual}`);
  }
  if (drift.length) {
    console.error(`\nEXCLUSION DRIFT: ${drift.length}`);
    for (const d of drift) console.error(`  ${d}`);
    console.error(
      "\nAn exclusion covers a known set of references. A changed count means a reference was added\n" +
        "or removed: re-read the comments, then update `expected` deliberately.",
    );
    process.exit(1);
  }

  if (findings.length) {
    console.error(`\nSTALE CONSUMER REFERENCES: ${findings.length}`);
    for (const x of findings) console.error(`  ${x.file}:${x.line} names ${x.symbol}, which exists in no live consumer`);
    console.error(
      "\nEach is a comment pointing at a file that is gone. Fix the comment, or add the symbol to\n" +
        "scripts/comment-symbol-refs.exclusions.json WITH A REASON if the reference is deliberate.",
    );
    process.exit(1);
  }

  console.log("\nno stale consumer references");
}

main();
