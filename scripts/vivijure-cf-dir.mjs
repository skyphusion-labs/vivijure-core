// Where the test suite finds its vivijure-cf checkout (core#355).
//
// Two consumers read from it: vitest.config.ts (the module manifests under modules/) and
// tests/helpers/d1-sqlite.ts (the D1 migrations under migrations/). Each used to try the same four
// fixed paths. Every sibling path was an UNSUFFIXED name (../vivijure-cf, ../vivijure), so a clone
// named for its sprint (~/dev/vivijure-core-<tag>) with a sibling named the same way matched none of
// them, and the error text sent the reader to create the unsuffixed ../vivijure-cf by hand. Two seats
// running as one user share one home, so that is the one path two clones can collide on.
//
// Now an explicit VIVIJURE_CF_DIR (the checkout ROOT, so one setting serves both consumers) wins,
// and the errors name the two paths that cannot collide: that override, and ./vivijure inside this
// clone (the CI path, ignored by .gitignore, core#359). The four fixed paths stay, in their old
// order: CI and vivijure-local depend on them.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const CF_DIR_ENV = "VIVIJURE_CF_DIR";

/** The fixed checkout roots, in order. */
export function cfCheckoutCandidates(root) {
  return [
    resolve(root, "vivijure"), // in-repo: CI sparse-checkout of vivijure-cf, and the safe dev path
    resolve(root, "../vivijure-cf"), // sibling clone named vivijure-cf
    resolve(root, "../vivijure"), // legacy alias when a sibling is named plain "vivijure"
    resolve(root, "../../vivijure"), // vivijure-local CI: workspace/{core,vivijure}
  ];
}

export function notFoundMessage(what) {
  return (
    `vivijure-cf ${what} not found. Either set ${CF_DIR_ENV} to your own vivijure-cf checkout, or ` +
    "sparse-checkout skyphusion-labs/vivijure-cf (modules, migrations) into ./vivijure inside this clone, " +
    "which is the CI path and is ignored by .gitignore."
  );
}

/** `<checkout>/<sub>` for the first checkout where `holds` is true. A set override that does not hold
 *  it is an ERROR, never a fall-through: falling through would run the suite against some other
 *  checkout and say nothing. */
export function findInVivijureCf(root, sub, holds, env = process.env) {
  const raw = env[CF_DIR_ENV];
  const override = typeof raw === "string" ? raw.trim() : "";
  if (override) {
    const dir = resolve(root, override, sub);
    if (!holds(dir)) throw new Error(`${CF_DIR_ENV}=${override} has no usable ${sub}/ (looked in ${dir}).`);
    return dir;
  }
  const hit = cfCheckoutCandidates(root).map((c) => resolve(c, sub)).find(holds);
  if (!hit) throw new Error(notFoundMessage(sub));
  return hit;
}

/** The module manifests: a data-only manifest.ts leaf (cf#285), or the entrypoint of a checkout from
 *  before the leaf extract. */
export function vivijureModulesDir(root, env = process.env) {
  return findInVivijureCf(
    root,
    "modules",
    (d) => existsSync(resolve(d, "keyframe/src/manifest.ts")) || existsSync(resolve(d, "keyframe/src/index.ts")),
    env,
  );
}

/** The D1 migrations. */
export function vivijureMigrationsDir(root, env = process.env) {
  return findInVivijureCf(root, "migrations", (d) => existsSync(resolve(d, "0001_init.sql")), env);
}
