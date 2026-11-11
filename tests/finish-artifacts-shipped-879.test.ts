// vivijure-cf#879 step 3: the core no longer reads a finish convention (output key, applied tag, frame-rate
// change) off a binding name, so every SHIPPED finish module must declare finish_artifacts. These are the
// real manifests from vivijure-cf (the same checkout the rest of this suite resolves). vivijure-local
// ships these modules as manifest fixtures synced from vivijure-cf (dev/manifests), so the same
// declarations cover it; its finish-lipsync fixture is the local copy of LIPSYNC_ARTIFACTS.
import { describe, expect, it } from "vitest";
import { MANIFEST as RIFE } from "vivijure-modules/finish-rife";
import { MANIFEST as UPSCALE } from "vivijure-modules/finish-upscale";
import { MANIFEST as BLENDER } from "vivijure-modules/finish-blender";
import { validateManifest } from "../src/modules/manifest-validate.js";
import { finishStepAppliedTag, finishStepRateFactor } from "../src/film-model.js";
import type { FinishShot } from "../src/film-model.js";
import type { RegisteredModule } from "../src/modules/types.js";
import { BLENDER_ARTIFACTS, RIFE_ARTIFACTS, UPSCALE_ARTIFACTS } from "./helpers/shipped-finish-artifacts.js";

const SHIPPED = [
  { m: RIFE, copy: RIFE_ARTIFACTS, interpolates: true },
  { m: UPSCALE, copy: UPSCALE_ARTIFACTS, interpolates: false },
  { m: BLENDER, copy: BLENDER_ARTIFACTS, interpolates: false },
];

describe("every shipped finish module declares its conventions", () => {
  it("CONTROL: these are the finish modules, and they load", () => {
    expect(SHIPPED.map((s) => s.m.name).sort()).toEqual(["finish-blender", "finish-rife", "finish-upscale"]);
    for (const { m } of SHIPPED) expect(m.hooks).toContain("finish");
  });
  for (const { m, copy, interpolates } of SHIPPED) {
    it(`${m.name} declares finish_artifacts${interpolates ? " with rate_factor" : ""}, and the test copy matches`, () => {
      expect(typeof validateManifest(m)).toBe("object");
      expect(m.finish_artifacts).toBeDefined();
      expect(m.finish_artifacts).toEqual(copy);
      expect(Boolean(m.finish_artifacts?.rate_factor)).toBe(interpolates);
    });
  }
});

describe("finish-rife reads as it did off its binding name", () => {
  const mod = { ...RIFE, binding: "MODULE_FINISH_RIFE" } as unknown as RegisteredModule;
  const shot = (config: Record<string, unknown>): FinishShot =>
    ({ shot_id: "s1", clip_key: "c.mp4", chain: ["MODULE_FINISH_RIFE"], configs: [config], idx: 0, status: "pending", applied: [] }) as unknown as FinishShot;
  for (const [config, tag, factor] of [
    [{}, "interpolate:2x", 2],
    [{ interpolation_factor: 4 }, "interpolate:4x", 4],
    [{ interpolate: false, interpolation_factor: 4 }, "noop:interpolate-off", 1],
  ] as [Record<string, unknown>, string, number][]) {
    it(`${JSON.stringify(config)}: tag ${tag}, rate x${factor}`, () => {
      expect(finishStepAppliedTag(shot(config), [mod])).toBe(tag);
      expect(finishStepRateFactor(mod.binding, config, mod.finish_artifacts)).toBe(factor);
    });
  }
});
