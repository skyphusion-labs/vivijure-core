import { describe, expect, it } from "vitest";
import { pairLastKeyframeKeys } from "../src/film-model.js";

describe("pairLastKeyframeKeys", () => {
  it("gives each shot the next shot's start still as the end frame", () => {
    const out = pairLastKeyframeKeys([
      { shot_id: "a", keyframe_key: "k/a.png" },
      { shot_id: "b", keyframe_key: "k/b.png" },
      { shot_id: "c", keyframe_key: "k/c.png" },
    ]);
    expect(out[0].last_keyframe_key).toBe("k/b.png");
    expect(out[1].last_keyframe_key).toBe("k/c.png");
    expect(out[2].last_keyframe_key).toBeUndefined();
  });

  it("is a no-op on a single shot", () => {
    const out = pairLastKeyframeKeys([{ shot_id: "only", keyframe_key: "k/only.png" }]);
    expect(out[0].last_keyframe_key).toBeUndefined();
  });
});
