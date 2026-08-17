import { describe, expect, it } from "vitest";
import {
  applyVoiceSeed,
  buildVoiceLock,
  composeMotionPrompt,
  pairLastKeyframeKeys,
  seedFromVoiceLock,
  voiceLockFromCast,
} from "../src/film-model.js";

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

describe("composeMotionPrompt", () => {
  it("locks look and voice onto every shot prompt", () => {
    const p = composeMotionPrompt("she turns to the window", {
      style_prefix: "35mm tungsten",
      voice_lock: "low alto, calm Texas",
    });
    expect(p).toContain("35mm tungsten");
    expect(p).toContain("low alto, calm Texas");
    expect(p).toContain("VOCAL IDENTITY LOCK");
    expect(p).toContain("she turns to the window");
  });

  it("buildVoiceLock names each speaker and forbids a new one", () => {
    const lock = buildVoiceLock([
      { name: "Mara", voice_id: "asteria" },
      { name: "Dex", voice_id: "zeus" },
    ]);
    expect(lock).toContain("Mara:");
    expect(lock).toContain("Dex:");
    expect(lock).toContain("Never invent a new speaker");
  });

  it("seedFromVoiceLock is stable and non-random", () => {
    const a = seedFromVoiceLock("Mara: clear mid female");
    const b = seedFromVoiceLock("Mara: clear mid female");
    const c = seedFromVoiceLock("Dex: deep resonant male");
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).not.toBe(c);
    expect(seedFromVoiceLock("")).toBe(-1);
  });

  it("omits the lock clause when voice_lock is empty", () => {
    const p = composeMotionPrompt("she turns", { style_prefix: "35mm", voice_lock: "  " });
    expect(p).toBe("35mm she turns");
    expect(p).not.toContain("VOCAL IDENTITY LOCK");
  });

  it("voiceLockFromCast names speakers from the cast maps and keeps extra as add-on", () => {
    const lock = voiceLockFromCast(
      { A: "Mara", B: "Dex" },
      { A: "asteria", B: "zeus" },
      "dry room tone",
    );
    expect(lock).toContain("Mara:");
    expect(lock).toContain("Dex:");
    expect(lock).toContain("clear mid female");
    expect(lock).toContain("deep resonant male");
    expect(lock).toContain("dry room tone");
    expect(lock).toContain("Never invent a new speaker");
  });

  it("voiceLockFromCast with no names and no extra is empty (caller must refuse native AV)", () => {
    expect(voiceLockFromCast(undefined, undefined)).toBe("");
    expect(voiceLockFromCast({}, {})).toBe("");
    expect(buildVoiceLock([])).toBe("");
  });

  it("applyVoiceSeed pins an unset / -1 seed and leaves a caller seed alone", () => {
    const lock = "Mara: clear mid female";
    const pinned = seedFromVoiceLock(lock);
    expect(applyVoiceSeed({}, lock)).toEqual({ seed: pinned });
    expect(applyVoiceSeed({ seed: -1 }, lock)).toEqual({ seed: pinned });
    expect(applyVoiceSeed({ seed: "" }, lock)).toEqual({ seed: pinned });
    expect(applyVoiceSeed({ seed: 42, steps: 8 }, lock)).toEqual({ seed: 42, steps: 8 });
    expect(applyVoiceSeed({ steps: 8 }, "")).toEqual({ steps: 8 });
    expect(applyVoiceSeed(undefined, "")).toBeUndefined();
  });
});
