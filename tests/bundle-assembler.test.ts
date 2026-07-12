import { describe, expect, it } from "vitest";
import {
  decodeDataUrl,
  detectImageExt,
  safeCharFilename,
} from "../src/bundle-assembler.js";
import { validateStoryboard } from "../src/storyboard-validate.js";
import { parseShotDurations, serializeStoryboardYaml } from "../src/planner-yaml.js";

const MIN_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

describe("bundle-assembler pure helpers", () => {
  it("safeCharFilename mirrors the GPU worker convention", () => {
    expect(safeCharFilename("A", "Neon Runner")).toBe("char_A_Neon_Runner.png");
  });

  it("decodeDataUrl round-trips MIN_PNG", () => {
    const url = `data:image/png;base64,${Buffer.from(MIN_PNG).toString("base64")}`;
    const bytes = decodeDataUrl(url);
    expect(bytes?.length).toBe(MIN_PNG.length);
    expect(detectImageExt(bytes!)).toBe("png");
  });
});

describe("planner-yaml + tar round-trip", () => {
  it("serializes target_seconds and parseShotDurations reads them back", () => {
    const validated = validateStoryboard({
      title: "dur_test",
      full_prompt: "test",
      duration_seconds: 8,
      clip_seconds: 4,
      style_prefix: "cinematic",
      style_category: "None",
      style_preset: "None",
      use_characters: [],
      scenes: [
        { id: "shot_01", prompt: "one", target_seconds: 3.5 },
        { id: "shot_02", prompt: "two", target_seconds: 4 },
      ],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const yaml = serializeStoryboardYaml(validated.value);
    expect(parseShotDurations(yaml)).toEqual({ shot_01: 3.5, shot_02: 4 });
  });

  it("gunzipBytes inverts gzipBytes", async () => {
    const { gzipBytes, gunzipBytes } = await import("../src/bundle-durations.js");
    const plain = new TextEncoder().encode("hello bundle");
    const gz = await gzipBytes(plain);
    const out = await gunzipBytes(gz);
    expect(out).toEqual(plain);
  });
});
