// core#355 and core#359: the suite finds the module manifests without forcing a seat onto the
// unsuffixed ../vivijure-cf path, and the in-repo ./vivijure path is ignored by git.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CF_DIR_ENV,
  cfCheckoutCandidates,
  notFoundMessage,
  vivijureMigrationsDir,
  vivijureModulesDir,
} from "../scripts/vivijure-cf-dir.mjs";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch tree: base/ws/core is the clone root; `checkout(rel)` plants a vivijure-cf checkout
 *  (module manifest plus first migration) at base/ws/core/<rel> and returns its root. */
function tree() {
  const base = mkdtempSync(join(tmpdir(), "core355-"));
  made.push(base);
  const root = join(base, "ws", "core");
  mkdirSync(root, { recursive: true });
  const checkout = (rel: string, parts: { modules?: boolean; migrations?: boolean } = { modules: true, migrations: true }) => {
    const dir = join(root, rel);
    if (parts.modules) {
      mkdirSync(join(dir, "modules", "keyframe", "src"), { recursive: true });
      writeFileSync(join(dir, "modules", "keyframe", "src", "manifest.ts"), "export {};\n");
    }
    if (parts.migrations) {
      mkdirSync(join(dir, "migrations"), { recursive: true });
      writeFileSync(join(dir, "migrations", "0001_init.sql"), "");
    }
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  return { root, checkout };
}

describe("the vivijure-cf checkout lookup (core#355)", () => {
  it("an explicit VIVIJURE_CF_DIR wins over every fixed path, for modules AND migrations", () => {
    const { root, checkout } = tree();
    checkout("vivijure");
    const own = checkout("../vivijure-cf-mytag"); // a suffixed sibling, matched by no fixed path
    const env = { [CF_DIR_ENV]: "../vivijure-cf-mytag" };
    expect(vivijureModulesDir(root, env)).toBe(join(own, "modules"));
    expect(vivijureMigrationsDir(root, env)).toBe(join(own, "migrations"));
    expect(vivijureModulesDir(root, { [CF_DIR_ENV]: own })).toBe(join(own, "modules")); // absolute too
  });

  it("control: without the override, a suffixed sibling is not found, which is the defect", () => {
    const { root, checkout } = tree();
    checkout("../vivijure-cf-mytag");
    expect(() => vivijureModulesDir(root, {})).toThrow(/modules not found/);
    expect(() => vivijureMigrationsDir(root, {})).toThrow(/migrations not found/);
  });

  it("a set override that lacks what is asked for fails loud, and does not fall through", () => {
    const { root, checkout } = tree();
    checkout("vivijure");
    checkout("../half", { modules: true });
    expect(() => vivijureModulesDir(root, { [CF_DIR_ENV]: "../nope" })).toThrow(/VIVIJURE_CF_DIR=\.\.\/nope has no usable modules\//);
    expect(vivijureModulesDir(root, { [CF_DIR_ENV]: "../half" })).toBe(join(root, "../half/modules"));
    expect(() => vivijureMigrationsDir(root, { [CF_DIR_ENV]: "../half" })).toThrow(/has no usable migrations\//);
  });

  it("a blank override is unset", () => {
    const { root, checkout } = tree();
    const inRepo = checkout("vivijure");
    expect(vivijureModulesDir(root, { [CF_DIR_ENV]: "  " })).toBe(join(inRepo, "modules"));
  });

  it("keeps the four fixed paths in their old order (CI and vivijure-local use them)", () => {
    const { root, checkout } = tree();
    expect(cfCheckoutCandidates(root)).toEqual([
      join(root, "vivijure"),
      join(root, "../vivijure-cf"),
      join(root, "../vivijure"),
      join(root, "../../vivijure"),
    ]);
    const sibling = checkout("../vivijure-cf");
    expect(vivijureMigrationsDir(root, {})).toBe(join(sibling, "migrations"));
    const inRepo = checkout("vivijure");
    expect(vivijureMigrationsDir(root, {})).toBe(join(inRepo, "migrations")); // the in-repo path is still first
  });

  it("follows a symlinked ./vivijure, the seat ritual from the issue", () => {
    const { root, checkout } = tree();
    const cf = checkout("../cf-checkout");
    symlinkSync(cf, join(root, "vivijure"));
    expect(vivijureModulesDir(root, {})).toBe(join(root, "vivijure/modules"));
  });

  it("the error names the two paths that cannot collide, and never advises the unsuffixed sibling", () => {
    const msg = notFoundMessage("modules");
    expect(msg).toMatch(/VIVIJURE_CF_DIR/);
    expect(msg).toMatch(/\.\/vivijure inside this clone/);
    expect(msg).not.toMatch(/\.\.\/vivijure-cf/);
  });
});

describe("./vivijure is ignored by .gitignore (core#359)", () => {
  // Run in a throwaway repo holding a copy of THIS repo's .gitignore, so the answer depends on the
  // committed rule alone: not on .git/info/exclude (the old seat ritual adds /vivijure there, which
  // would pass with .gitignore untouched), and not on what ./vivijure happens to be in this clone.
  const gitignore = readFileSync(join(import.meta.dirname, "..", ".gitignore"), "utf8");
  function repoWith(shape: "dir" | "symlink") {
    const dir = mkdtempSync(join(tmpdir(), "core359-"));
    made.push(dir);
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir, ".gitignore"), gitignore);
    mkdirSync(join(dir, "src", "vivijure"), { recursive: true });
    writeFileSync(join(dir, "src", "vivijure", "x.ts"), "");
    const cf = join(dir, "..", `${dir.split("/").pop()}-cf`);
    mkdirSync(join(cf, "modules", "keyframe", "src"), { recursive: true });
    made.push(cf);
    writeFileSync(join(cf, "modules", "keyframe", "src", "manifest.ts"), "");
    if (shape === "symlink") symlinkSync(cf, join(dir, "vivijure"));
    else {
      mkdirSync(join(dir, "vivijure", "modules", "keyframe", "src"), { recursive: true });
      writeFileSync(join(dir, "vivijure", "modules", "keyframe", "src", "manifest.ts"), "");
    }
    return dir;
  }
  const untracked = (dir: string) =>
    execFileSync("git", ["-C", dir, "status", "--porcelain", "-uall"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const rule = (dir: string, path: string) =>
    execFileSync("git", ["-C", dir, "check-ignore", "-v", path], { encoding: "utf8" }).trim();

  it("a sparse checkout at ./vivijure shows nothing untracked, by the .gitignore rule", () => {
    const dir = repoWith("dir");
    expect(untracked(dir)).toEqual(["?? .gitignore", "?? src/vivijure/x.ts"]);
    expect(rule(dir, "vivijure")).toMatch(/^\.gitignore:\d+:\/vivijure\t/);
    expect(rule(dir, "vivijure/modules/keyframe/src/manifest.ts")).toMatch(/^\.gitignore:\d+:\/vivijure\t/);
  });

  it("a symlink named vivijure is ignored too (a trailing-slash rule would miss it)", () => {
    const dir = repoWith("symlink");
    expect(untracked(dir)).toEqual(["?? .gitignore", "?? src/vivijure/x.ts"]);
    expect(rule(dir, "vivijure")).toMatch(/^\.gitignore:\d+:\/vivijure\t/);
  });

  it("control: without the rule the checkout shows up, and a nested vivijure/ is never swallowed", () => {
    const dir = repoWith("dir");
    writeFileSync(join(dir, ".gitignore"), gitignore.replace(/^\/vivijure$/m, ""));
    expect(untracked(dir)).toContain("?? vivijure/modules/keyframe/src/manifest.ts");
    expect(untracked(repoWith("dir"))).toContain("?? src/vivijure/x.ts");
  });
});
