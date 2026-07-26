import { describe, expect, it } from "vitest";
import {
  parseCastTrainBodyFields,
  resolveCastTrainFamily,
  wanTrainEndpointConfigured,
} from "../src/cast-lora-train.js";

describe("parseCastTrainBodyFields", () => {
  it("ignores renderOverrides wan family when Wan train is not wired", () => {
    const body = parseCastTrainBodyFields(
      { renderOverrides: { model_family: "wan" } },
      false,
    );
    expect(body.modelFamily).toBe("sdxl");
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
});

describe("resolveCastTrainFamily", () => {
  it("defaults to wan when the dedicated endpoint is wired and family is omitted", () => {
    expect(resolveCastTrainFamily(true)).toBe("wan");
    expect(resolveCastTrainFamily(true, "")).toBe("wan");
  });

  it("defaults to sdxl when Wan train is not wired", () => {
    expect(resolveCastTrainFamily(false)).toBe("sdxl");
  });

  it("honors explicit sdxl escape hatch even when Wan is wired", () => {
    expect(resolveCastTrainFamily(true, "sdxl")).toBe("sdxl");
    expect(resolveCastTrainFamily(true, "SDXL")).toBe("sdxl");
  });

  it("honors explicit wan request when wired", () => {
    expect(resolveCastTrainFamily(true, "wan")).toBe("wan");
  });

  it("falls back to sdxl for explicit wan when not wired", () => {
    expect(resolveCastTrainFamily(false, "wan")).toBe("sdxl");
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
