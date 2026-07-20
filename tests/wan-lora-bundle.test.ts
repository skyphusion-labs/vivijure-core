import { describe, expect, it } from "vitest";
import {
  deriveWanLoraDestKeys,
  extractTrainedWanLoraKeys,
  extractTrainedLoraKey,
  buildWanLoraConfigArrays,
} from "../src/lora-bundle.js";

describe("deriveWanLoraDestKeys", () => {
  it("builds the two per-cast timestamped expert keys", () => {
    expect(deriveWanLoraDestKeys(7, 1780000000)).toEqual({
      high: "loras/cast-7/1780000000.high.safetensors",
      low: "loras/cast-7/1780000000.low.safetensors",
    });
  });
});

describe("extractTrainedWanLoraKeys", () => {
  it("reads the two-expert wan shape (output.lora[slot].lora_id_high/low)", () => {
    const out = {
      project: "p",
      lora: { A: { lora_id_high: "loras/cast-7/h.safetensors", lora_id_low: "loras/cast-7/l.safetensors", family: "wan" } },
    };
    expect(extractTrainedWanLoraKeys(out)).toEqual({
      high: "loras/cast-7/h.safetensors",
      low: "loras/cast-7/l.safetensors",
    });
  });

  it("returns null on the single-file SDXL shape (explicit two-shape handling)", () => {
    // control: the wan extractor must NOT mis-harvest an sdxl result
    expect(extractTrainedWanLoraKeys({ lora: { A: { lora_id: "loras/cast-7/one.safetensors" } } })).toBeNull();
  });

  it("returns null when only one expert is present (half-result is not a pair)", () => {
    expect(extractTrainedWanLoraKeys({ lora: { A: { lora_id_high: "loras/h.safetensors" } } })).toBeNull();
    expect(extractTrainedWanLoraKeys({ lora: { A: { lora_id_low: "loras/l.safetensors" } } })).toBeNull();
    expect(extractTrainedWanLoraKeys({ lora: { A: { lora_id_high: "", lora_id_low: "" } } })).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(extractTrainedWanLoraKeys(null)).toBeNull();
    expect(extractTrainedWanLoraKeys("nope")).toBeNull();
    expect(extractTrainedWanLoraKeys({ lora: {} })).toBeNull();
    expect(extractTrainedWanLoraKeys({ project: "p" })).toBeNull();
  });
});

describe("the two extractors are shape-disjoint (control)", () => {
  it("sdxl extractor returns null on a pure-wan result (no KeyError, no mis-harvest)", () => {
    const wan = { lora: { A: { lora_id_high: "h.safetensors", lora_id_low: "l.safetensors", family: "wan" } } };
    expect(extractTrainedLoraKey(wan)).toBeNull();
    expect(extractTrainedWanLoraKeys(wan)).toEqual({ high: "h.safetensors", low: "l.safetensors" });
  });

  it("wan extractor returns null on a pure-sdxl result; sdxl extractor reads it", () => {
    const sdxl = { lora: { A: { lora_id: "one.safetensors" } } };
    expect(extractTrainedWanLoraKeys(sdxl)).toBeNull();
    expect(extractTrainedLoraKey(sdxl)).toBe("one.safetensors");
  });
});

describe("buildWanLoraConfigArrays", () => {
  it("defaults scale to 1.5, NOT 1.0 (the cf#29 spike learning)", () => {
    const arrays = buildWanLoraConfigArrays("https://r2/high", "https://r2/low");
    expect(JSON.parse(arrays.high_noise_loras)).toEqual([{ path: "https://r2/high", scale: 1.5 }]);
    expect(JSON.parse(arrays.low_noise_loras)).toEqual([{ path: "https://r2/low", scale: 1.5 }]);
  });

  it("honors an explicit scale override", () => {
    const arrays = buildWanLoraConfigArrays("https://r2/high", "https://r2/low", 1.0);
    expect(JSON.parse(arrays.high_noise_loras)[0].scale).toBe(1.0);
    expect(JSON.parse(arrays.low_noise_loras)[0].scale).toBe(1.0);
  });
});
