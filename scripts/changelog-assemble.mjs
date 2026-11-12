#!/usr/bin/env node
// Assembles changelog.d/ fragments (plus whatever is still sitting under the open Unreleased-shaped
// heading) into a released section at release time (core#202, ported design from vivijure-cf
// scripts/changelog-assemble.py cf#546, itself ported from vivijure-control-plane cp#358).
//
// WHY FRAGMENTS. core#202 measured core#195 re-resolved on CHANGELOG.md FOUR times, content
// unchanged, because every sibling merge moved the single heading it was appending under. One
// fragment file per PR removes the shared anchor: two PRs adding two different files never touch
// the same file, so the conflict class disappears rather than being made cheaper.
//
// TWO SHAPES OF A CYCLE (core#550, bump-at-release, fleet-chezmoi#1766).
// The estate cuts releases bump-at-release: a version moves only in the release PR. So after a
// release, main sits on a tagged version with a RELEASED top heading and no open Unreleased heading,
// and feature PRs add changelog.d/ fragments without bumping anything. The release PR then bumps
// package.json and package-lock.json and runs this script, which has two cases:
//   1. The top heading is Unreleased-shaped (a direct-edit cycle, or the older open-once shape):
//      RENAME it into the released section, legacy body first, then the fragments. Nothing about
//      this path changed.
//   2. The top heading is a RELEASED one (the bump-at-release steady state): INSERT a new released
//      section above it, built from the fragments. There is no Unreleased heading to promote and
//      none is needed, because a fragment carries no heading reference (core#212).
// It refuses, writing nothing, when there is nothing to release: no Unreleased heading AND no
// fragments.
//
// This script still does not leave a permanent empty Unreleased anchor (unlike the vivijure-cf
// port): after a release the top heading is the released one.
//
// <version> IS AN EXPLICIT ARGUMENT, matching vivijure-cf and vivijure-control-plane, never
// inferred from the topmost heading.
//
// Refuses loudly, and writes nothing, when there is nothing to release (the top heading is not
// Unreleased-shaped and changelog.d holds no fragment) or when <version> already appears as a
// heading anywhere in CHANGELOG.md -- so re-running this for an already-promoted version cannot
// duplicate the heading.

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const FRAGMENT_DIR = "changelog.d";

// Matches the same top-heading shape tests/changelog-version.test.ts topChangelogClaim() accepts
// as unreleased: bare Unreleased, bracketed [Unreleased], or either spelling combined with a
// target semver (Unreleased / v1.15.0, Unreleased / 1.15.0).
const OPEN_HEADING = /^##\s+(?:\[Unreleased\]|Unreleased)(?:\s*\/\s*v?\d+\.\d+\.\d+)?\s*$/i;

export function normalizeVersion(v) {
  return v.startsWith("v") ? v : "v" + v;
}

export function versionHeadingPresent(lines, version) {
  const bare = version.replace(/^v/, "");
  const needleBracket = "## [" + bare + "]";
  const needleBare = "## " + version;
  for (const line of lines) {
    if (line === needleBracket || line.startsWith(needleBracket + " ")) return true;
    if (line === needleBare || line.startsWith(needleBare + " ")) return true;
  }
  return false;
}

// Finds the FIRST `## ` heading in the file, wherever it is (a title line and prose commonly
// precede it, as in this repo CHANGELOG.md today), and checks whether THAT heading -- the live
// claim, matching topChangelogClaim() in tests/changelog-version.test.ts -- is Unreleased-shaped.
export function openSectionBounds(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      start = i;
      break;
    }
  }
  if (start === -1 || !OPEN_HEADING.test(lines[start])) {
    return null;
  }
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j].startsWith("## ")) {
      end = j;
      break;
    }
  }
  return [start, end];
}

export function readFragments(root) {
  const dir = join(root, FRAGMENT_DIR);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { names: [], bodies: [] };
  }
  const names = entries.filter((n) => n.endsWith(".md") && n !== ".gitkeep").sort();
  const bodies = names.map((n) => readFileSync(join(dir, n), "utf8").trim());
  return { names, bodies };
}

export function assemble(text, fragmentNames, fragmentBodies, versionArg, date) {
  const version = normalizeVersion(versionArg);
  const lines = text.split("\n");

  if (versionHeadingPresent(lines, version)) {
    return {
      ok: false,
      message:
        "refusing: a heading for " + version + " already appears in CHANGELOG.md. Re-running " +
        "this script for a version already promoted would duplicate the heading. Nothing was " +
        "written.",
    };
  }

  const bounds = openSectionBounds(lines);
  if (bounds === null) {
    // Bump-at-release steady state (core#550): a released top heading and fragments waiting.
    if (fragmentBodies.length === 0) {
      return {
        ok: false,
        message:
          "refusing: CHANGELOG.md does not open with an Unreleased-shaped heading and " +
          "changelog.d holds no fragment. Nothing to promote (see RELEASES.md).",
      };
    }
    const first = lines.findIndex((l) => l.startsWith("## "));
    const at = first === -1 ? lines.length : first;
    const bareV = version.replace(/^v/, "");
    const inserted = ["## [" + bareV + "] -- " + date, ""]
      .concat(fragmentBodies.join("\n\n").trim().split("\n"), [""]);
    return { ok: true, text: lines.slice(0, at).concat(inserted, lines.slice(at)).join("\n") };
  }
  const start = bounds[0];
  const end = bounds[1];
  const legacyBody = lines.slice(start + 1, end).join("\n").trim();

  const parts = [];
  if (legacyBody) parts.push(legacyBody);
  for (const b of fragmentBodies) parts.push(b);
  const content = parts.join("\n\n").trim();

  const bare = version.replace(/^v/, "");
  const newSection = ["## [" + bare + "] -- " + date, ""];
  if (content) newSection.push(content);
  newSection.push("");

  const newLines = lines.slice(0, start).concat(newSection, lines.slice(end));
  return { ok: true, text: newLines.join("\n") };
}

function main(argv) {
  const version = argv[2];
  const date = argv[3];
  if (!version || !date) {
    console.error("usage: changelog-assemble.mjs <version> <date>");
    return 2;
  }
  const root = ".";
  const changelogPath = join(root, "CHANGELOG.md");
  const text = readFileSync(changelogPath, "utf8");
  const fragments = readFragments(root);
  const result = assemble(text, fragments.names, fragments.bodies, version, date);
  if (!result.ok) {
    console.error("changelog-assemble: " + result.message);
    return 1;
  }
  writeFileSync(changelogPath, result.text);
  for (const n of fragments.names) {
    unlinkSync(join(root, FRAGMENT_DIR, n));
  }
  let summary = "consumed " + fragments.names.length + " fragment(s)";
  if (fragments.names.length > 0) summary += ": " + fragments.names.join(", ");
  console.log(
    "changelog-assemble: wrote heading for " + normalizeVersion(version) + " -- " + date + ", " + summary,
  );
  return 0;
}

if (import.meta.url === "file://" + process.argv[1]) {
  process.exit(main(process.argv));
}
