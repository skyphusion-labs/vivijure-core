import { describe, expect, it } from "vitest";
import { assertProjectKey, isProjectKey } from "../src/key-safety.js";

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
