// Temp directories a test file makes and then removes itself (core#484).
//
// A suite that calls mkdtempSync and never removes the result leaks one directory per run into the
// shared TMPDIR. On a seat that runs the suite many times a day, those leaks add up to thousands.
// This helper records every path it makes. cleanup() removes exactly those paths, each by its own
// name. It never matches by prefix and never lists the TMPDIR, so it cannot remove a directory that
// another run, another suite, or another seat made with the same prefix.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface OwnedTmp {
  /** Make a fresh directory under the OS temp dir and record it for cleanup. */
  make(): string;
  /** Remove every directory this tracker made, by exact path, and forget them. */
  cleanup(): void;
}

export function ownedTmp(prefix: string): OwnedTmp {
  const made: string[] = [];
  return {
    make(): string {
      const path = mkdtempSync(join(tmpdir(), prefix));
      made.push(path);
      return path;
    },
    cleanup(): void {
      for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
    },
  };
}
