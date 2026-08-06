// Hand-written ambient module contract drift guard (core#105).
//
// tests/vivijure-modules.d.ts exists because tsc cannot follow vitest's resolve.alias into
// vivijure-cf module sources without typechecking a foreign Workers project under this repo's
// compiler options (core#101). The .d.ts is therefore a HAND-WRITTEN claim: each
// `vivijure-modules/<name>` specifier exports `MANIFEST: ModuleManifest`.
//
// That claim can go stale without a red typecheck:
//   - vitest aliases a module the .d.ts never declares (or the reverse)
//   - the real MANIFEST no longer validates as ModuleManifest
//   - the .d.ts invents exports / types that runtime does not provide
//
// quality-tier-drift.test.ts already loads the REAL MANIFEST at runtime and asserts enum values.
// This suite is the structural counterpart: it keeps the hand-written .d.ts honest against the
// alias set and against validateManifest / conformance on the live module sources.
// Prefer this drift test over a generator (core#105).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { MANIFEST as KEYFRAME_MANIFEST } from "vivijure-modules/keyframe";
import { MANIFEST as OWN_GPU_MANIFEST } from "vivijure-modules/own-gpu";
import { validateManifest } from "../src/modules/manifest-validate.js";
import {
  checkManifest,
  allPass,
  failures,
} from "../src/modules/conformance.js";
import type { ModuleManifest } from "../src/modules/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DTS_PATH = resolve(root, "tests/vivijure-modules.d.ts");
const VITEST_PATH = resolve(root, "vitest.config.ts");

/** Modules that quality-tier-drift (and this suite) import via the vivijure-modules/* alias. */
const REAL_MANIFESTS: Record<string, ModuleManifest> = {
  keyframe: KEYFRAME_MANIFEST,
  "own-gpu": OWN_GPU_MANIFEST,
};

/** Module names declared as `declare module "vivijure-modules/<name>"` in the hand-written .d.ts. */
function declaredModules(dts: string): string[] {
  const names: string[] = [];
  const re = /declare\s+module\s+["']vivijure-modules\/([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dts)) !== null) names.push(m[1]);
  return names.slice().sort();
}

/** Module names aliased as `find: "vivijure-modules/<name>"` in vitest.config.ts. */
function aliasedModules(cfg: string): string[] {
  const names: string[] = [];
  const re = /find:\s*["']vivijure-modules\/([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cfg)) !== null) names.push(m[1]);
  return names.slice().sort();
}

/** Body of one `declare module "vivijure-modules/<name>" { ... }` block (braces balanced). */
function moduleBlock(dts: string, name: string): string | null {
  const startRe = new RegExp(
    `declare\\s+module\\s+["']vivijure-modules\\/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*\\{`,
  );
  const start = dts.search(startRe);
  if (start < 0) return null;
  const open = dts.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < dts.length; i++) {
    if (dts[i] === "{") depth++;
    else if (dts[i] === "}") {
      depth--;
      if (depth === 0) return dts.slice(open + 1, i);
    }
  }
  return null;
}

describe("vivijure-modules.d.ts drift guard (core#105)", () => {
  const dts = readFileSync(DTS_PATH, "utf8");
  const vitestCfg = readFileSync(VITEST_PATH, "utf8");
  const declared = declaredModules(dts);
  const aliased = aliasedModules(vitestCfg);

  it("declares at least one module (canary: the .d.ts is not empty)", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it("declares exactly the modules vitest aliases as vivijure-modules/*", () => {
    expect(declared, "hand-written .d.ts modules").toEqual(aliased);
  });

  it("declares exactly the modules this suite loads from real sources", () => {
    expect(declared).toEqual(Object.keys(REAL_MANIFESTS).slice().sort());
  });

  for (const name of Object.keys(REAL_MANIFESTS).slice().sort()) {
    it(`declare module "vivijure-modules/${name}" only exports MANIFEST: ModuleManifest`, () => {
      const body = moduleBlock(dts, name);
      expect(body, `missing declare module for vivijure-modules/${name}`).not.toBeNull();
      const compact = (body as string).replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
      // Thin ambient contract only -- no invented exports that tsc would trust at import sites.
      expect(compact).toMatch(
        /^import type \{ ModuleManifest \} from ["']\.\.\/src\/modules\/types\.js["']; export const MANIFEST: ModuleManifest;$/,
      );
    });

    it(`real ${name} MANIFEST validates as ModuleManifest (runtime vs .d.ts claim)`, () => {
      const manifest = REAL_MANIFESTS[name];
      const validated = validateManifest(manifest);
      expect(
        typeof validated,
        `validateManifest(${name}): ${String(validated)}`,
      ).toBe("object");
      const checks = checkManifest(manifest);
      expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
      // The .d.ts promises ModuleManifest; name must match the specifier suffix used in aliases.
      expect(manifest.name).toBe(name);
    });
  }

  it("planted control: a declaration set that omits an alias fails the equality check", () => {
    // Proves the fail direction of the alias/d.ts equality gate (core#105 residual of core#101).
    const incomplete = declared.filter((n) => n !== declared[0]);
    expect(incomplete).not.toEqual(aliased);
  });
});
