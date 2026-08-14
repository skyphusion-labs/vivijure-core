import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** Resolve vivijure module manifests for quality-tier-drift (CI vs nested dev layout). */
function vivijureModulesDir(): string {
  const candidates = [
    resolve(root, "vivijure/modules"), // CI: vivijure-cf sparse-checkout into repo-root/vivijure (see ci/publish workflows)
    resolve(root, "../vivijure-cf/modules"), // sibling clone (local or propagandhi) (~/dev/{core,vivijure-cf})
    resolve(root, "../vivijure/modules"), // legacy alias when a sibling is named plain "vivijure"
    resolve(root, "../../vivijure/modules"), // vivijure-local CI: workspace/{core,vivijure}
  ];
  // Prefer data-only manifest.ts leaves (cf#285 / core quality-tier-drift); fall back to
  // entrypoints for checkouts that predate the leaf extract.
  const hit = candidates.find(
    (c) =>
      existsSync(resolve(c, "keyframe/src/manifest.ts")) ||
      existsSync(resolve(c, "keyframe/src/index.ts")),
  );
  if (!hit) {
    throw new Error(
      "vivijure module manifests not found. Clone skyphusion-labs/vivijure-cf " +
        "(CI: sparse-checkout to vivijure/; dev: sibling ../vivijure-cf).",
    );
  }
  return hit;
}

const modules = vivijureModulesDir();

/** Prefer leaf MANIFEST files (cf#285) so the guard does not import module entrypoints. */
function manifestEntry(mod: string): string {
  const leaf = resolve(modules, `${mod}/src/manifest.ts`);
  if (existsSync(leaf)) return leaf;
  return resolve(modules, `${mod}/src/index.ts`);
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Drops the per-isolate module-discovery cache before every test (cf#515 defect 2): caching the
    // service scan by default makes suite isolation a requirement, not a nicety.
    setupFiles: ["./tests/setup-registry-cache.ts"],
  },
  resolve: {
    // Sparse-checkout of vivijure-cf modules has no node_modules. Older entrypoints
    // imported `@skyphusion-labs/vivijure-core/...` subpaths; without an alias those
    // resolve from the module file and fail. Point them at this package's src.
    // After cf#285 the preferred path is data-only manifest.ts (no runtime graph).
    alias: [
      {
        find: /^@skyphusion-labs\/vivijure-core\/(.+)$/,
        replacement: resolve(root, "src/$1.ts"),
      },
      {
        find: "vivijure-modules/keyframe",
        replacement: manifestEntry("keyframe"),
      },
      {
        find: "vivijure-modules/own-gpu",
        replacement: manifestEntry("own-gpu"),
      },
    ],
  },
});
