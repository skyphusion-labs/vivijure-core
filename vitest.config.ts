import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** Resolve vivijure module manifests for quality-tier-drift (CI vs nested dev layout). */
function vivijureModulesDir(): string {
  const candidates = [
    resolve(root, "../vivijure/modules"), // CI: vivijure checked out beside repo root
    resolve(root, "../../vivijure/modules"), // dev: sibling under ~/dev or ~/Documents/GitHub
  ];
  const hit = candidates.find((c) => existsSync(resolve(c, "keyframe/src/index.ts")));
  if (!hit) {
    throw new Error(
      "vivijure module manifests not found. Clone skyphusion-labs/vivijure as a sibling " +
        "(../vivijure in CI, or ../../vivijure in a nested dev tree).",
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
    alias: {
      "vivijure-modules/keyframe": resolve(modules, "keyframe/src/index.ts"),
      "vivijure-modules/own-gpu": resolve(modules, "own-gpu/src/index.ts"),
    },
  },
});
