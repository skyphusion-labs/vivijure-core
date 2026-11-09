import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERDICT, decide, exitCodeFor, proveInstalled } from "../scripts/consumer-suite.mjs";

// core#335 option 1b: the consumer-suite verdict, driven in every direction, plus an end to end run of
// the SHIPPED script with real npm against a fake core and a fake consumer (no network: a package with
// no dependencies, a local tarball). The point of the issue is that UNMEASURED and PASS rendered the
// same, so every case asserts the verdict WORD, not only the exit status.

const SCRIPT = "scripts/consumer-suite.mjs";
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "core-335-"));
  scratch.push(d);
  return d;
}

const ALL = { consumerInstall: true, baseline: true, pack: true, candidateInstall: true, proven: true, candidate: true };

describe("decide (core#335)", () => {
  it("PASS only when every stage is ok", () => {
    expect(decide(ALL).verdict).toBe(VERDICT.PASS);
  });
  it("a red candidate on a green baseline is FAIL", () => {
    expect(decide({ ...ALL, candidate: false }).verdict).toBe(VERDICT.FAIL);
  });
  it("a red baseline is UNMEASURED, whatever the candidate did", () => {
    expect(decide({ ...ALL, baseline: false }).verdict).toBe(VERDICT.UNMEASURED);
    expect(decide({ ...ALL, baseline: false, candidate: false }).verdict).toBe(VERDICT.UNMEASURED);
  });
  it("a consumer that will not install is UNMEASURED", () => {
    expect(decide({ consumerInstall: false }).verdict).toBe(VERDICT.UNMEASURED);
  });
  it("an unproven candidate is UNMEASURED, never PASS", () => {
    expect(decide({ ...ALL, proven: false }).verdict).toBe(VERDICT.UNMEASURED);
  });
  it("a core build that will not pack or install is FAIL", () => {
    expect(decide({ ...ALL, pack: false }).verdict).toBe(VERDICT.FAIL);
    expect(decide({ ...ALL, candidateInstall: false }).verdict).toBe(VERDICT.FAIL);
  });
  it("only FAIL blocks (the ruling): UNMEASURED and PASS exit 0, FAIL exits 1", () => {
    expect(exitCodeFor(VERDICT.PASS)).toBe(0);
    expect(exitCodeFor(VERDICT.UNMEASURED)).toBe(0);
    expect(exitCodeFor(VERDICT.FAIL)).toBe(1);
  });
});

describe("proveInstalled (core#335)", () => {
  function trees(same: boolean) {
    const d = dir();
    for (const t of ["core", "inst"]) mkdirSync(join(d, t, "dist"), { recursive: true });
    writeFileSync(join(d, "core", "dist", "index.js"), "export * from './a.js';\n");
    writeFileSync(join(d, "inst", "dist", "index.js"), "export * from './a.js';\n");
    writeFileSync(join(d, "core", "dist", "a.js"), "export const v = 2;\n");
    writeFileSync(join(d, "inst", "dist", "a.js"), same ? "export const v = 2;\n" : "export const v = 1;\n");
    return d;
  }
  it("CONTROL: identical trees are proven", () => {
    const d = trees(true);
    expect(proveInstalled(join(d, "core"), join(d, "inst"), ["dist/index.js", "dist/a.js"]).ok).toBe(true);
  });
  it("a barrel main that matches while another file differs is NOT proven (measured on 1.41.3)", () => {
    const d = trees(false);
    const r = proveInstalled(join(d, "core"), join(d, "inst"), ["dist/index.js", "dist/a.js"]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("dist/a.js");
  });
  it("an empty file list is NOT proven", () => {
    const d = trees(true);
    expect(proveInstalled(join(d, "core"), join(d, "inst"), ["package.json"]).ok).toBe(false);
  });
});

/** A fake core package: dist/index.js, no dependencies, nothing to build. */
function fakeCore(body: string): string {
  const d = dir();
  mkdirSync(join(d, "dist"));
  writeFileSync(join(d, "dist", "index.js"), body);
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@skyphusion-labs/vivijure-core", version: "9.9.9", main: "./dist/index.js", files: ["dist"] }));
  return d;
}

/** A fake consumer. Its test is red when the installed core says BREAK, or when baseline-red exists
 *  and no core is installed yet (so the baseline, and only the baseline, is red). */
function fakeConsumer(opts: { baselineRed?: boolean; badLock?: boolean } = {}): string {
  const d = dir();
  writeFileSync(
    join(d, "check.cjs"),
    [
      "const fs = require('fs');",
      "const p = 'node_modules/@skyphusion-labs/vivijure-core/dist/index.js';",
      "if (!fs.existsSync(p)) process.exit(fs.existsSync('baseline-red') ? 1 : 0);",
      "process.exit(fs.readFileSync(p, 'utf8').includes('BREAK') ? 1 : 0);",
    ].join("\n"),
  );
  if (opts.baselineRed) writeFileSync(join(d, "baseline-red"), "");
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "fake-consumer", version: "1.0.0", private: true, scripts: { typecheck: "node -e 0", test: "node check.cjs" } }));
  writeFileSync(
    join(d, "package-lock.json"),
    opts.badLock ? "{ not json" : JSON.stringify({ name: "fake-consumer", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fake-consumer", version: "1.0.0" } } }),
  );
  return d;
}

function cli(core: string, consumer: string): { status: number; out: string } {
  const env = { ...process.env, GITHUB_STEP_SUMMARY: "" };
  try {
    const out = execFileSync("node", [SCRIPT, "--core", core, "--consumer", consumer, "--name", "fake"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, out };
  } catch (e: any) {
    return { status: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

describe("consumer-suite.mjs end to end, real npm (core#335)", () => {
  it("PASS: green on its pin and on this build", () => {
    const r = cli(fakeCore("export const ok = 1;\n"), fakeConsumer());
    expect(r.out).toContain("consumer-suite fake: PASS");
    expect(r.out).toContain("all 1 packed files match this build");
    expect(r.status).toBe(0);
  }, 120_000);

  it("FAIL: green on its pin, red on this build", () => {
    const r = cli(fakeCore("export const BREAK = 1;\n"), fakeConsumer());
    expect(r.out).toContain("consumer-suite fake: FAIL");
    expect(r.out).toContain("::error title=consumer-fake: FAIL::");
    expect(r.status).toBe(1);
  }, 120_000);

  it("UNMEASURED: red on its own pin does not blame core, and does not block", () => {
    const r = cli(fakeCore("export const BREAK = 1;\n"), fakeConsumer({ baselineRed: true }));
    expect(r.out).toContain("consumer-suite fake: UNMEASURED");
    expect(r.out).toContain("::warning title=consumer-fake: UNMEASURED::");
    expect(r.out).not.toContain(": PASS");
    expect(r.status).toBe(0);
  }, 120_000);

  it("UNMEASURED: a consumer that will not install", () => {
    const r = cli(fakeCore("export const ok = 1;\n"), fakeConsumer({ badLock: true }));
    expect(r.out).toContain("consumer-suite fake: UNMEASURED");
    expect(r.status).toBe(0);
  }, 120_000);

  it("usage errors exit 2", () => {
    const d = dir();
    expect(cli(d, d).status).toBe(2);
  });
});

describe("ci.yml wiring (core#335)", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  it("a consumer-cf job checks out cf, installs core, and runs the script on both", () => {
    const job = ci.slice(ci.indexOf("\n  consumer-cf:\n"));
    expect(job.length).toBeGreaterThan(0);
    expect(job).toContain("repository: skyphusion-labs/vivijure-cf");
    expect(job).toContain("node core/scripts/consumer-suite.mjs --core core --consumer cf --name cf");
    expect(job).not.toMatch(/continue-on-error/);
  });
});
