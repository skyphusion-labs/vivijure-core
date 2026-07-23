import { describe, expect, it } from "vitest";
import {
  resolveCastTrainFamily,
  wanTrainEndpointConfigured,
} from "../src/cast-lora-train.js";

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

  it("honors explicit wan request", () => {
    expect(resolveCastTrainFamily(false, "wan")).toBe("wan");
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
