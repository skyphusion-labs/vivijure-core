// The finish_artifacts the SHIPPED finish modules declare, copied from their manifests (vivijure-cf
// modules/<name>/src/manifest.ts; vivijure-local dev/manifests/<name>.json). Since vivijure-cf#879 step 3
// the core reads conventions only from a declaration, so a test that stands in for a shipped module
// declares what that module declares. tests/finish-artifacts-shipped-879.test.ts checks the cf copies.
import type { FinishArtifactsDecl } from "../../src/modules/types.js";

export const RIFE_ARTIFACTS: FinishArtifactsDecl = {
  output_key: { kind: "shot_named", filename: "_finished.mp4" },
  applied: [
    { when: { knob: "interpolate", equals: false }, tag: "noop:interpolate-off" },
    { tag: "interpolate:{interpolation_factor|2}x" },
  ],
  rate_factor: { knob: "interpolation_factor", default: 2, off_when: { knob: "interpolate", equals: false } },
};

export const UPSCALE_ARTIFACTS: FinishArtifactsDecl = {
  output_key: { kind: "append_suffix", suffix: "_up" },
  applied: [{ tag: "upscale:{scale|2}x" }],
};

export const LIPSYNC_ARTIFACTS: FinishArtifactsDecl = {
  output_key: { kind: "append_suffix", suffix: "_ls" },
  applied: [{ tag: "lipsync:{version|v15}" }],
};

export const BLENDER_ARTIFACTS: FinishArtifactsDecl = {
  output_key: { kind: "append_suffix", suffix: "_bl" },
  applied: [{ tag: "blender:{job_type|grade}:{preset|filmic_warm}" }],
};
