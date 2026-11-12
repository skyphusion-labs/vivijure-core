// core#554: the suite runs in a fresh TMPDIR and fails if it leaves anything behind
// (tests/helpers/suite-tmpdir.ts, wired as the vitest globalSetup).
//
// Three layers: this very run is inside a guard root (the wiring); the leftover rule itself; and a
// child vitest, given a TMPDIR of its own, that goes red on a leaking test file and green on a clean
// one, and removes its root either way.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED, ROOT_PREFIX, leakMessage, leftovers } from "./helpers/suite-tmpdir.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureConfig = join(repoRoot, "tests", "fixtures", "tmp-leak-554", "vitest.config.ts");

const made: string[] = [];
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "core-554-"));
  made.push(d);
  return d;
}

describe("core#554: wiring", () => {
  it("this test runs with os.tmpdir() inside a fresh guard root", () => {
    expect(basename(realpathSync(tmpdir())).startsWith(ROOT_PREFIX)).toBe(true);
  });
});

describe("core#554: the leftover rule", () => {
  it("an empty root, or one holding only Node's compile cache, has no leftovers", () => {
    const d = scratch();
    expect(leftovers(d)).toEqual([]);
    for (const name of ALLOWED) mkdirSync(join(d, name));
    expect(leftovers(d)).toEqual([]);
  });

  it("anything else is a leftover, named in the message", () => {
    const d = scratch();
    mkdirSync(join(d, "core-316-abc123"));
    mkdirSync(join(d, "node-compile-cache"));
    expect(leftovers(d)).toEqual(["core-316-abc123"]);
    expect(leakMessage(["core-316-abc123"])).toMatch(/left 1 entry in its TMPDIR \(core-316-abc123\)/);
  });
});

function childRun(fixture: string) {
  const isolated = scratch();
  const vitest = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  const r = spawnSync(process.execPath, [vitest, "run", "--config", fixtureConfig], {
    cwd: repoRoot,
    env: { ...process.env, TMPDIR: isolated, CORE_554_FIXTURE: fixture },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, left: readdirSync(isolated) };
}

describe("core#554: a child run", () => {
  it("goes RED on a test that leaks a temp dir, names it, and still removes its root", { timeout: 120_000 }, () => {
    const r = childRun("leaky.fixture.ts");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("core#554: the suite left 1 entry in its TMPDIR (core-554-leaky-");
    // The leak never reaches the TMPDIR the run was given: the guard root went, with the leak in it.
    expect(r.left.filter((n) => n.startsWith(ROOT_PREFIX) || n.startsWith("core-554-leaky-"))).toEqual([]);
  });

  it("CONTROL: stays green on a test that cleans up, and removes its root", { timeout: 120_000 }, () => {
    const r = childRun("clean.fixture.ts");
    expect(r.out).toContain("1 passed");
    expect(r.status).toBe(0);
    expect(r.left.filter((n) => n.startsWith(ROOT_PREFIX))).toEqual([]);
  });
});
