import { describe, expect, it } from "vitest";
import {
  parseCastTrainBodyFields,
  resolveCastTrainFamily,
  wanTrainEndpointConfigured,
} from "../src/cast-lora-train.js";

// core#174. The resolver's job is to separate TWO different questions, and it must never answer
// one with the other:
//
//   1. "the caller expressed no preference"  -> we pick a DEFAULT. Wan when the dedicated endpoint
//      is wired, SDXL otherwise. Choosing for someone who did not choose is legitimate.
//   2. "the caller explicitly asked for wan" -> we HONOUR it and return "wan", whatever the host
//      state. If the endpoint is not wired, executeCastTrain's shipped 501 refuses. We never
//      substitute a different, cheaper model family for an EXPRESSED request.
//
// Before the fix both branches returned `wanConfigured ? "wan" : "sdxl"`, so (2) collapsed into
// (1) and an explicit "wan" was byte-identical to sending nothing. The tests below deliberately
// probe with wanConfigured=FALSE, because on wanConfigured=true honoured and substituted produce
// the same value and no assertion can tell them apart.

describe("parseCastTrainBodyFields", () => {
  it("honors an explicit renderOverrides wan family even when Wan train is NOT wired (core#174)", () => {
    // Was asserted as "sdxl". That assertion pinned the silent substitution as intended behaviour.
    const body = parseCastTrainBodyFields(
      { renderOverrides: { model_family: "wan" } },
      false,
    );
    expect(body.modelFamily).toBe("wan");
  });

  it("honors an explicit top-level wan family even when Wan train is NOT wired (core#174)", () => {
    expect(
      parseCastTrainBodyFields({ model_family: "wan" }, false).modelFamily,
    ).toBe("wan");
  });

  it("honors renderOverrides sdxl when Wan train is not wired", () => {
    expect(
      parseCastTrainBodyFields({ renderOverrides: { model_family: "sdxl" } }, false)
        .modelFamily,
    ).toBe("sdxl");
  });

  it("top-level model_family wins over renderOverrides", () => {
    const body = parseCastTrainBodyFields(
      {
        model_family: "sdxl",
        renderOverrides: { model_family: "wan" },
      },
      true,
    );
    expect(body.modelFamily).toBe("sdxl");
  });

  it("leaves modelFamily undefined when no family field is present", () => {
    expect(parseCastTrainBodyFields({ renderOverrides: {} }, false).modelFamily)
      .toBeUndefined();
  });

  it("clamps train_overrides to the worker allow-list (wan-train#37)", () => {
    const body = parseCastTrainBodyFields(
      { train_overrides: { batch_size: 2, steps: 1000, no_such: 9 } },
      true,
    );
    expect(body.trainOverrides).toEqual({ batch_size: 2, steps: 1000 });
  });
});

describe("resolveCastTrainFamily -- DEFAULT path (no preference expressed)", () => {
  // These four are the sibling-green control set for the core#174 change: the fix must move the
  // EXPLICIT path and leave every one of these untouched. If a change reddens both groups it has
  // altered the default, not the substitution.
  it("defaults to wan when the dedicated endpoint is wired and family is omitted", () => {
    expect(resolveCastTrainFamily(true)).toBe("wan");
    expect(resolveCastTrainFamily(true, "")).toBe("wan");
    expect(resolveCastTrainFamily(true, "   ")).toBe("wan");
  });

  it("defaults to sdxl when Wan train is not wired and family is omitted", () => {
    expect(resolveCastTrainFamily(false)).toBe("sdxl");
    expect(resolveCastTrainFamily(false, "")).toBe("sdxl");
    expect(resolveCastTrainFamily(false, null)).toBe("sdxl");
  });

  it("treats an UNRECOGNISED family as no preference, never as an honoured request", () => {
    // "flux" is not a family this resolver supports. It must take the default path, not be
    // waved through as an explicit request (which would reach the 501 for the wrong reason).
    expect(resolveCastTrainFamily(false, "flux")).toBe("sdxl");
    expect(resolveCastTrainFamily(true, "flux")).toBe("wan");
  });
});

describe("resolveCastTrainFamily -- EXPLICIT path (a preference was expressed)", () => {
  it("honors explicit sdxl escape hatch in BOTH host states", () => {
    expect(resolveCastTrainFamily(true, "sdxl")).toBe("sdxl");
    expect(resolveCastTrainFamily(true, "SDXL")).toBe("sdxl");
    expect(resolveCastTrainFamily(false, "sdxl")).toBe("sdxl");
  });

  it("honors explicit wan when the endpoint IS wired", () => {
    expect(resolveCastTrainFamily(true, "wan")).toBe("wan");
  });

  // THE DISCRIMINATING ASSERTION (core#174). This is the only case in the whole function where
  // the broken and the correct implementation differ, so it is the only assertion that can fail
  // against the defect. Everything else above passes either way.
  it("honors explicit wan when the endpoint is NOT wired, so the route's 501 can refuse honestly", () => {
    expect(resolveCastTrainFamily(false, "wan")).toBe("wan");
  });

  it("normalises case and whitespace on an explicit wan against an UNWIRED host", () => {
    // Probing normalisation on the non-default host state as well: on a wired host every one of
    // these returns "wan" whether or not normalisation ran, so the assertion would be vacuous.
    expect(resolveCastTrainFamily(false, "WAN")).toBe("wan");
    expect(resolveCastTrainFamily(false, "  wan  ")).toBe("wan");
    expect(resolveCastTrainFamily(false, "Wan")).toBe("wan");
  });
});

describe("wanTrainEndpointConfigured", () => {
  it("is true when RUNPOD_WAN_TRAIN_ENDPOINT_ID resolves non-empty", async () => {
    await expect(
      wanTrainEndpointConfigured({ RUNPOD_WAN_TRAIN_ENDPOINT_ID: "8kjcn5sz6k8p1n" } as never),
    ).resolves.toBe(true);
  });

  it("is false when the binding is missing or blank", async () => {
    await expect(wanTrainEndpointConfigured({} as never)).resolves.toBe(false);
    await expect(
      wanTrainEndpointConfigured({ RUNPOD_WAN_TRAIN_ENDPOINT_ID: "  " } as never),
    ).resolves.toBe(false);
  });
});
