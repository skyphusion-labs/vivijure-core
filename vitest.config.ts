import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { vivijureModulesDir } from "./scripts/vivijure-cf-dir.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// Module manifests for quality-tier-drift: VIVIJURE_CF_DIR first, then ./vivijure (CI), then the
// fixed siblings. See scripts/vivijure-cf-dir.mjs (core#355).
const modules = vivijureModulesDir(root);

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
      // vivijure-cf#879 step 3: the shipped finish modules, so the core can check what they declare.
      {
        find: "vivijure-modules/finish-rife",
        replacement: manifestEntry("finish-rife"),
      },
      {
        find: "vivijure-modules/finish-upscale",
        replacement: manifestEntry("finish-upscale"),
      },
      {
        find: "vivijure-modules/finish-blender",
        replacement: manifestEntry("finish-blender"),
      },
    ],
  },
});
