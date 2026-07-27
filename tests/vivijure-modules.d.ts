// Ambient type declarations for the vivijure-modules/* specifiers that only exist at test runtime
// via the resolve.alias entries in vitest.config.ts (a sparse-checkout or sibling clone of
// vivijure-cf, resolved dynamically -- see vivijureModulesDir()). tsc has no equivalent alias
// mechanism that would let it resolve these to real files without also type-checking vivijure-cf's
// source under vivijure-core's own compiler options (a different project: Cloudflare Workers
// globals, different moduleResolution settings). These declarations give the test file the same
// contract the alias promises at runtime -- a MANIFEST conforming to ModuleManifest -- without
// pulling a foreign codebase into this program (core#101).
declare module "vivijure-modules/keyframe" {
  import type { ModuleManifest } from "../src/modules/types.js";
  export const MANIFEST: ModuleManifest;
}

declare module "vivijure-modules/own-gpu" {
  import type { ModuleManifest } from "../src/modules/types.js";
  export const MANIFEST: ModuleManifest;
}
