import { describe, expect, it } from "vitest";
import {
  coupleLocalGpuKeyframeChoice,
  localKeyframeModule,
  resolveRenderPipeline,
} from "../src/modules/render-pipeline.js";
import { localGpuKeyframePreflightError } from "../src/modules/registry.js";
import { resolveModuleRenderConfigs } from "../src/render-module-config.js";
import type { RegisteredModule } from "../src/modules/types.js";

const runpodKeyframe = {
  name: "keyframe",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_KEYFRAME",
  hooks: ["keyframe" as const],
  config_schema: {
    quality_tier: { type: "enum" as const, values: ["draft", "standard", "final"], default: "final" },
  },
  ui: { section: "keyframe", order: 10 },
} as unknown as RegisteredModule;

const cloudKeyframe = {
  name: "cloud-keyframe",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_CLOUD_KEYFRAME",
  hooks: ["keyframe" as const],
  config_schema: {
    model: { type: "enum" as const, values: ["flux-2"], default: "flux-2" },
  },
  ui: { section: "keyframe", order: 20, locality: "cloud" as const },
} as unknown as RegisteredModule;

const localGpu = {
  name: "local-gpu",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_LOCAL_GPU",
  hooks: ["motion.backend" as const, "keyframe" as const],
  config_schema: {
    quality: { type: "enum" as const, values: ["draft", "standard", "final"], default: "standard" },
    quality_tier: { type: "enum" as const, values: ["draft", "standard", "final"], default: "final" },
  },
  ui: { section: "motion", order: 4, locality: "local" as const },
  keyframe_label: "SDXL (local)",
} as unknown as RegisteredModule;

const ownGpu = {
  name: "own-gpu",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_OWN_GPU",
  hooks: ["motion.backend" as const],
  config_schema: {
    quality: { type: "enum" as const, values: ["draft", "standard", "final"], default: "standard" },
  },
  ui: { section: "motion", order: 5, locality: "byo" as const },
} as unknown as RegisteredModule;

const mods = [runpodKeyframe, cloudKeyframe, localGpu, ownGpu];

describe("local-gpu keyframe coupling (#153)", () => {
  it("finds the dual-hook local-gpu module as the local keyframe", () => {
    expect(localKeyframeModule(mods, "local-gpu")?.name).toBe("local-gpu");
  });

  it("defaults an omitted keyframe choice onto local-gpu when motion is local-gpu", () => {
    expect(coupleLocalGpuKeyframeChoice(mods, "local-gpu", undefined)).toBe("local-gpu");
    const pipeline = resolveRenderPipeline(mods, { motion_backend_choice: "local-gpu" });
    expect(pipeline.motion_backend?.name).toBe("local-gpu");
    expect(pipeline.keyframe?.name).toBe("local-gpu");
  });

  it("does not couple when motion is byo/cloud", () => {
    expect(coupleLocalGpuKeyframeChoice(mods, "own-gpu", undefined)).toBeUndefined();
    const pipeline = resolveRenderPipeline(mods, { motion_backend_choice: "own-gpu" });
    expect(pipeline.keyframe?.name).toBe("keyframe");
  });

  it("resolveModuleRenderConfigs injects quality_tier onto local-gpu when coupled", () => {
    const resolved = resolveModuleRenderConfigs(
      { motion_backend: "local-gpu" },
      "draft",
      mods,
    );
    expect(resolved.motion_backend).toBe("local-gpu");
    expect(resolved.keyframe_backend).toBe("local-gpu");
    expect(resolved.keyframe_config).toMatchObject({ quality_tier: "draft" });
    expect(resolved.motion_config).toMatchObject({ quality: "draft" });
  });

  it("preflight fails loud when local motion pairs with RunPod keyframe", () => {
    const err = localGpuKeyframePreflightError(mods, "local-gpu", "keyframe");
    expect(err).toMatch(/requires local keyframes/i);
    expect(err).toMatch(/local-gpu/);
  });

  it("preflight fails when no local keyframe module is installed", () => {
    const motionOnly = [runpodKeyframe, { ...localGpu, hooks: ["motion.backend" as const] }];
    const err = localGpuKeyframePreflightError(motionOnly, "local-gpu", undefined);
    expect(err).toMatch(/no local keyframe module/i);
  });

  it("preflight is clean when local motion + local keyframe (coupled or explicit)", () => {
    expect(localGpuKeyframePreflightError(mods, "local-gpu", "local-gpu")).toBeNull();
    expect(localGpuKeyframePreflightError(mods, "local-gpu", undefined)).toBeNull();
    expect(localGpuKeyframePreflightError(mods, "own-gpu", "keyframe")).toBeNull();
  });
});
