// core#554 fixture: a child vitest run with the real suite-tmpdir globalSetup and one fixture file.
// Driven by tests/suite-tmpdir-554.test.ts; never part of the main suite (its include does not match).
import { defineConfig } from "vitest/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: here,
    include: [process.env.CORE_554_FIXTURE ?? "clean.fixture.ts"],
    globalSetup: [join(here, "..", "..", "helpers", "suite-tmpdir.ts")],
  },
});
