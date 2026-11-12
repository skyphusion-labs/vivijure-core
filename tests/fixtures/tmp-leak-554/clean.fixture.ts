// core#554 fixture: makes a temp dir and removes it.
import { it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("cleans up its temp dir", () => {
  const d = mkdtempSync(join(tmpdir(), "core-554-clean-"));
  rmSync(d, { recursive: true, force: true });
});
