// core#554 fixture: makes a temp dir and never removes it, the defect the guard exists to catch.
import { it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("leaks one temp dir", () => {
  mkdtempSync(join(tmpdir(), "core-554-leaky-"));
});
