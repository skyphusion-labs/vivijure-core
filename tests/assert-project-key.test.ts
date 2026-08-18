import { describe, expect, it } from "vitest";
import { assertBankedLoraKey, assertProjectKey, isBankedLoraKey, isProjectKey } from "../src/key-safety.js";

describe("assertProjectKey", () => {
  it("accepts a safe key under renders/<project>/", () => {
    expect(assertProjectKey("neon", "renders/neon/clips/shot_01.mp4")).toBe(
      "renders/neon/clips/shot_01.mp4",
    );
    expect(isProjectKey("neon", "renders/neon/keyframes/shot_01.png")).toBe(true);
  });

  it("refuses a key that escapes the project prefix", () => {
    expect(() => assertProjectKey("neon", "renders/other/clips/shot_01.mp4")).toThrow(
      /refused key outside renders\/neon\//,
    );
    expect(() => assertProjectKey("neon", "renders/neon/../other/x.mp4")).toThrow(
      /refused key outside/,
    );
    expect(() => assertProjectKey("neon", "bundles/neon/bundle.tar.gz")).toThrow(
      /refused key outside/,
    );
    expect(isProjectKey("neon", "renders/neon")).toBe(false);
    expect(isProjectKey("neon", "/renders/neon/clips/x.mp4")).toBe(false);
  });
});

describe("assertBankedLoraKey", () => {
  it("accepts a character-stable loras/ key (cross-project reuse)", () => {
    expect(assertBankedLoraKey("loras/wren.safetensors")).toBe("loras/wren.safetensors");
    expect(isBankedLoraKey("loras/cast-18.safetensors")).toBe(true);
  });

  it("accepts a render-scoped adapter under renders/", () => {
    expect(assertBankedLoraKey("renders/last_call/loras/A.safetensors")).toBe(
      "renders/last_call/loras/A.safetensors",
    );
  });

  it("refuses a path that is not a LoRA bank", () => {
    expect(() => assertBankedLoraKey("bundles/x.tar.gz")).toThrow(/refused LoRA key/);
    expect(isBankedLoraKey("../loras/x.safetensors")).toBe(false);
  });
});
