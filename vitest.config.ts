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
  const hit = candidates.find((c) => existsSync(resolve(c, "keyframe/src/index.ts")));
  if (!hit) {
    throw new Error(
      "vivijure module manifests not found. Clone skyphusion-labs/vivijure-cf " +
        "(CI: sparse-checkout to vivijure/; dev: sibling ../vivijure-cf).",
    );
  }
  return hit;
}

const modules = vivijureModulesDir();

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    // Sparse-checkout of vivijure-cf modules has no node_modules. Module entrypoints
    // import `@skyphusion-labs/vivijure-core/...` subpaths; without an alias those
    // resolve from the module file and fail (local/main CI after cf#184). Point them
    // at this package's src so quality-tier-drift can load MANIFEST without a cf install.
    alias: [
      {
        find: /^@skyphusion-labs\/vivijure-core\/(.+)$/,
        replacement: resolve(root, "src/$1.ts"),
      },
      {
        find: "vivijure-modules/keyframe",
        replacement: resolve(modules, "keyframe/src/index.ts"),
      },
      {
        find: "vivijure-modules/own-gpu",
        replacement: resolve(modules, "own-gpu/src/index.ts"),
      },
    ],
  },
});
