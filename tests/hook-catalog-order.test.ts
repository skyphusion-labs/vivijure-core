import { describe, expect, it } from "vitest";
import { hookCatalog } from "../src/modules/registry.js";
import {
  HOOK_DISPLAY_ORDER,
  HOOK_NAMES,
  type HookName,
} from "../src/modules/types.js";

describe("hook catalog display order (core#54)", () => {
  it("every shipped hook has a unique display order", () => {
    const orders = HOOK_NAMES.map((n) => HOOK_DISPLAY_ORDER[n]);
    expect(orders).toHaveLength(HOOK_NAMES.length);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("hookCatalog emits order and sorts into the pipeline display sequence", () => {
    const catalog = hookCatalog();
    expect(catalog.every((h) => typeof h.order === "number")).toBe(true);
    const byOrder = [...catalog].sort((a, b) => a.order - b.order).map((h) => h.name);
    const expected: HookName[] = [
      "plan.enhance",
      "cast.image",
      "image.generate",
      "keyframe",
      "motion.backend",
      "dialogue",
      "speech",
      "finish",
      "score",
      "master",
      "film.finish",
      "notify",
    ];
    expect(byOrder).toEqual(expected);
  });
});
