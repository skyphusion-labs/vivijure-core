// vivijure-cf#879 (MA-8): a finish module DECLARES how it changes the frame rate
// (finish_artifacts.rate_factor), so the core stops reading it off the binding name. Until every finish
// module declares, a manifest without rate_factor keeps the legacy /RIFE/ reading.
import { describe, it, expect } from "vitest";
import { finishStepRateFactor, predictDeliveryFps } from "../src/film-model.js";
import { validateManifest } from "../src/modules/manifest-validate.js";
import { MODULE_API, type FinishArtifactsDecl } from "../src/modules/types.js";

const RIFE_DECL: FinishArtifactsDecl = {
  output_key: { kind: "shot_named", filename: "_finished.mp4" },
  rate_factor: { knob: "interpolation_factor", default: 2, off_when: { knob: "interpolate", equals: false } },
};
const NO_RATE: FinishArtifactsDecl = { output_key: { kind: "append_suffix", suffix: "_up" } };

describe("finishStepRateFactor reads a declared rate_factor", () => {
  // A binding with no RIFE in its name: only the declaration can make it interpolate.
  const B = "MODULE_SMOOTHER";
  it("the knob's value, or the default when absent", () => {
    expect(finishStepRateFactor(B, {}, RIFE_DECL)).toBe(2);
    expect(finishStepRateFactor(B, { interpolation_factor: 3 }, RIFE_DECL)).toBe(3);
  });
  it("off_when turns it off", () => {
    expect(finishStepRateFactor(B, { interpolate: false, interpolation_factor: 4 }, RIFE_DECL)).toBe(1);
  });
  it("a value that is not a number above 1 counts as 1", () => {
    for (const v of [1, 0, -2, "fast"]) expect(finishStepRateFactor(B, { interpolation_factor: v }, RIFE_DECL)).toBe(1);
  });
  it("the declaration wins over the binding name in both directions", () => {
    expect(finishStepRateFactor("MODULE_FINISH_RIFE", { interpolation_factor: 2 }, { ...RIFE_DECL, rate_factor: { knob: "x", default: 1 } })).toBe(1);
    expect(finishStepRateFactor(B, {}, RIFE_DECL)).toBe(2);
  });
});

describe("legacy reading stays until every module declares", () => {
  it("no declaration: /RIFE/ binding as before", () => {
    expect(finishStepRateFactor("MODULE_FINISH_RIFE", {})).toBe(2);
    expect(finishStepRateFactor("MODULE_FINISH_RIFE", { interpolate: false })).toBe(1);
    expect(finishStepRateFactor("MODULE_SMOOTHER", {})).toBe(1);
  });
  it("a declaration without rate_factor also keeps the legacy reading (cf finish-rife today)", () => {
    expect(finishStepRateFactor("MODULE_FINISH_RIFE", {}, NO_RATE)).toBe(2);
    expect(finishStepRateFactor("MODULE_FINISH_UPSCALE", {}, NO_RATE)).toBe(1);
  });
});

describe("predictDeliveryFps carries the declaration through", () => {
  it("a declared smoother doubles the rate; the same chain without it does not", () => {
    expect(predictDeliveryFps({}, [[{ binding: "MODULE_SMOOTHER", config: {}, artifacts: RIFE_DECL }]])).toBe(48);
    expect(predictDeliveryFps({}, [[{ binding: "MODULE_SMOOTHER", config: {} }]])).toBe(24);
  });
  it("an operator rate still wins", () => {
    expect(predictDeliveryFps({ delivery_fps: 30 }, [[{ binding: "MODULE_SMOOTHER", config: {}, artifacts: RIFE_DECL }]])).toBe(30);
  });
});

describe("validateManifest checks rate_factor", () => {
  const base = (fa: unknown) => ({ name: "m", version: "1.0.0", api: MODULE_API, hooks: ["finish"], finish_artifacts: fa });
  it("CONTROL: a well-formed declaration validates", () => {
    expect(typeof validateManifest(base(RIFE_DECL))).toBe("object");
    expect(typeof validateManifest(base({ ...RIFE_DECL, rate_factor: { knob: "f", default: 1 } }))).toBe("object");
  });
  for (const [label, rf, msg] of [
    ["no knob", { default: 2 }, /rate_factor\.knob missing/],
    ["a string default", { knob: "f", default: "2" }, /rate_factor\.default/],
    ["a default below 1", { knob: "f", default: 0.5 }, /rate_factor\.default/],
    ["a malformed off_when", { knob: "f", default: 2, off_when: { knob: "x" } }, /off_when/],
    ["not an object", 2, /rate_factor\.knob missing/],
  ] as [string, unknown, RegExp][]) {
    it(`refuses ${label}`, () => {
      const r = validateManifest(base({ ...RIFE_DECL, rate_factor: rf }));
      expect(typeof r).toBe("string");
      expect(r as string).toMatch(msg);
    });
  }
});
