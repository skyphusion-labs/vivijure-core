// core#484: the changelog suites must not leave fixture directories in TMPDIR.
//
// Each of these suites makes git fixture repos with mkdtempSync. Before core#484 none of them
// removed what it made, so every `npm test` left one directory per fixture behind. This test runs
// the three suites in a child vitest whose TMPDIR is a fresh directory of its own, then asserts
// that no entry with any of their prefixes is left in it.
//
// The child gets its OWN temp root, never the shared one, for two reasons. Other runs may be making
// directories with the same prefixes at the same moment, so a count against the shared TMPDIR
// would be flaky in both directions. And it means this test never has to list, match or delete
// anything it did not make: the only path it removes is the root it created.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SUITES = [
  "tests/changelog-assemble.test.ts",
  "tests/changelog-fragment-no-misfile.test.ts",
  "tests/changelog-entry-required.test.ts",
];

const PREFIXES = [
  "core-316-",
  "core-changelog-guard-",
  "core-212-repro-",
  "core-changelog-assemble-",
];

const isolated = mkdtempSync(join(tmpdir(), "core-484-leak-"));
afterAll(() => rmSync(isolated, { recursive: true, force: true }));

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TMPDIR: isolated };
}

interface VitestJson {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  testResults: { name: string }[];
}

describe("core#484: the changelog suites clean up their fixture directories", () => {
  it("CONTROL: a child process given this TMPDIR resolves it as os.tmpdir()", () => {
    const seen = execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(require('node:os').tmpdir())"],
      { env: childEnv(), encoding: "utf8" },
    );
    expect(realpathSync(seen)).toBe(realpathSync(isolated));
  });

  it("running the three suites leaves no entry with their prefixes in TMPDIR", { timeout: 180_000 }, () => {
    const vitest = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
    // The report goes to a named file, not stdout: vitest prints a status line on stdout too.
    const reportPath = join(isolated, "report.json");
    execFileSync(
      process.execPath,
      [vitest, "run", "--reporter=json", `--outputFile=${reportPath}`, ...SUITES],
      { cwd: repoRoot, env: childEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJson;

    // The run has to have happened for an empty directory to mean anything.
    expect(report.success).toBe(true);
    expect(report.testResults.map((r) => r.name.slice(repoRoot.length + 1)).sort()).toEqual(
      [...SUITES].sort(),
    );
    expect(report.numPassedTests).toBe(report.numTotalTests);
    expect(report.numPassedTests).toBeGreaterThan(20);

    const left = readdirSync(isolated).filter((name) => PREFIXES.some((p) => name.startsWith(p)));
    expect(left).toEqual([]);
  });
});
