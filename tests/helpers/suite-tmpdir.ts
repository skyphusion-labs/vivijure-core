// core#554: the whole suite runs in a fresh TMPDIR, and fails if it leaves anything there.
//
// Wired as a vitest globalSetup, so it runs in the main process before any worker starts. Workers
// inherit the environment, and os.tmpdir() reads TMPDIR at call time, so every mkdtempSync in every
// test lands under ROOT instead of the seat's own TMPDIR.
//
// At teardown it lists ROOT. Anything left (other than ALLOWED) is a test that did not remove what it
// made: the run fails and names the entries. ROOT is then removed by its exact path in every case,
// so a leak never reaches the seat's TMPDIR. This file never lists, matches or deletes anything in
// the parent TMPDIR; the only path it removes is the one it created.

import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Created by Node itself (the module compile cache), not by a test. Reused across runs. */
export const ALLOWED = new Set(["node-compile-cache"]);

export const ROOT_PREFIX = "core-suite-tmp-";

/** The names under `root` that are leaks: everything except ALLOWED, sorted. */
export function leftovers(root: string): string[] {
  return readdirSync(root).filter((name) => !ALLOWED.has(name)).sort();
}

/** The teardown message for a non-empty leftover list. */
export function leakMessage(left: string[]): string {
  const shown = left.slice(0, 20).join(", ");
  const more = left.length > 20 ? `, and ${left.length - 20} more` : "";
  return (
    `core#554: the suite left ${left.length} entr${left.length === 1 ? "y" : "ies"} in its TMPDIR ` +
    `(${shown}${more}). Remove every temp dir a test makes (tests/helpers/owned-tmp.ts, or an ` +
    `afterEach/finally rmSync).`
  );
}

export default function setup(): () => void {
  const previous = process.env.TMPDIR;
  const root = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)));
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    let left: string[];
    try {
      left = leftovers(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    if (left.length > 0) throw new Error(leakMessage(left));
  };
}
