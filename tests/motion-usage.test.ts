import { describe, expect, it } from "vitest";
import { MODULE_API, type MotionUsageDecl, type RegisteredModule } from "../src/modules/types.js";
import { validateManifest } from "../src/modules/manifest-validate.js";
import {
  generateAudioOn,
  motionScatterAllowed,
  parseMotionUsage,
  usageLimitLines,
  usageNeedsVoiceLock,
  usageOf,
} from "../src/motion-usage.js";

const VALID: MotionUsageDecl = {
  native_audio: true,
  voice: "prompt_lock",
  scatter_native_audio: true,
  min_seconds: 4,
  max_seconds: 12,
};

function usageMod(usage: unknown): RegisteredModule {
  return {
    name: "m",
    version: "1.0.0",
    api: MODULE_API,
    hooks: ["motion.backend"],
    binding: "MODULE_M",
    usage: usage as MotionUsageDecl,
  };
}

describe("parseMotionUsage", () => {
  it("accepts a complete declaration", () => {
    expect(parseMotionUsage(VALID)).toEqual({
      ...VALID,
      duration_steps: undefined,
      first_last: false,
      seed: false,
    });
  });

  it("keeps duration_steps, first_last, and seed when they are well-formed", () => {
    const raw = {
      ...VALID,
      voice: "seed_and_prompt",
      duration_steps: [4, 6, 8],
      first_last: true,
      seed: true,
    };
    expect(parseMotionUsage(raw)).toEqual({
      native_audio: true,
      voice: "seed_and_prompt",
      scatter_native_audio: true,
      min_seconds: 4,
      max_seconds: 12,
      duration_steps: [4, 6, 8],
      first_last: true,
      seed: true,
    });
  });

  it("drops non-positive / non-finite duration_steps and omits an emptied list", () => {
    expect(parseMotionUsage({ ...VALID, duration_steps: [4, "x", 0, -1, Number.NaN, 8] })?.duration_steps)
      .toEqual([4, 8]);
    expect(parseMotionUsage({ ...VALID, duration_steps: [0, -1] })?.duration_steps).toBeUndefined();
    expect(parseMotionUsage({ ...VALID, duration_steps: "4/8" })?.duration_steps).toBeUndefined();
  });

  it("treats first_last / seed as true only on the boolean true", () => {
    expect(parseMotionUsage({ ...VALID, first_last: 1, seed: "yes" })).toMatchObject({
      first_last: false,
      seed: false,
    });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "prompt_lock"],
    ["missing native_audio", { voice: "prompt_lock", scatter_native_audio: true, min_seconds: 4, max_seconds: 8 }],
    ["native_audio not boolean", { ...VALID, native_audio: "true" }],
    ["unknown voice", { ...VALID, voice: "invented" }],
    ["missing voice", { native_audio: true, scatter_native_audio: true, min_seconds: 4, max_seconds: 8 }],
    ["scatter not boolean", { ...VALID, scatter_native_audio: 1 }],
    ["min_seconds 0", { ...VALID, min_seconds: 0 }],
    ["min_seconds negative", { ...VALID, min_seconds: -1 }],
    ["min_seconds NaN", { ...VALID, min_seconds: Number.NaN }],
    ["max < min", { ...VALID, min_seconds: 8, max_seconds: 4 }],
    ["max not finite", { ...VALID, max_seconds: Number.POSITIVE_INFINITY }],
  ])("refuses %s", (_label, raw) => {
    expect(parseMotionUsage(raw)).toBeUndefined();
  });
});

describe("usageOf", () => {
  it("returns undefined when the module is missing or usage is malformed", () => {
    expect(usageOf(undefined)).toBeUndefined();
    expect(usageOf(usageMod(undefined))).toBeUndefined();
    expect(usageOf(usageMod({ ...VALID, voice: "nope" }))).toBeUndefined();
  });

  it("parses a well-formed usage block off the registered module", () => {
    expect(usageOf(usageMod(VALID))).toMatchObject(VALID);
  });
});

describe("generateAudioOn", () => {
  it("defaults to talking when the knob is absent", () => {
    expect(generateAudioOn(undefined)).toBe(true);
    expect(generateAudioOn({})).toBe(true);
    expect(generateAudioOn({ generate_audio: true })).toBe(true);
  });

  it("is false only when generate_audio is explicitly false", () => {
    expect(generateAudioOn({ generate_audio: false })).toBe(false);
  });
});

describe("motionScatterAllowed", () => {
  it("never scatters talking clips", () => {
    expect(motionScatterAllowed(VALID, true)).toBe(false);
    expect(motionScatterAllowed({ ...VALID, scatter_native_audio: true }, true)).toBe(false);
    expect(motionScatterAllowed(undefined, true)).toBe(false);
  });

  it("never scatters the look doors", () => {
    expect(motionScatterAllowed({ ...VALID, native_audio: false }, true, "own-gpu")).toBe(false);
    expect(motionScatterAllowed({ ...VALID, native_audio: false }, false, "local-gpu")).toBe(false);
  });

  it("allows silent cloud scatter unless the door declared it off", () => {
    expect(motionScatterAllowed({ ...VALID, native_audio: false, scatter_native_audio: true }, true)).toBe(true);
    expect(motionScatterAllowed({ ...VALID, native_audio: false, scatter_native_audio: false }, true)).toBe(false);
    expect(motionScatterAllowed({ ...VALID, scatter_native_audio: false }, false)).toBe(false);
  });
});

describe("usageNeedsVoiceLock", () => {
  it("is false when there is nothing to lock", () => {
    expect(usageNeedsVoiceLock(undefined, true)).toBe(false);
    expect(usageNeedsVoiceLock({ ...VALID, native_audio: false }, true)).toBe(false);
    expect(usageNeedsVoiceLock(VALID, false)).toBe(false);
    expect(usageNeedsVoiceLock({ ...VALID, voice: "cast_tts" }, true)).toBe(false);
  });

  it.each(["prompt_lock", "seed_and_prompt", "prev_clip"] as const)(
    "is true for native %s",
    (voice) => {
      expect(usageNeedsVoiceLock({ ...VALID, voice }, true)).toBe(true);
    },
  );
});

describe("usageLimitLines", () => {
  it("names the discrete duration grid when present", () => {
    const lines = usageLimitLines({ ...VALID, duration_steps: [4, 6, 8] });
    expect(lines[0]).toBe("4/6/8s clips");
  });

  it("falls back to a min-max range without a grid", () => {
    expect(usageLimitLines(VALID)[0]).toBe("4-12s clips");
  });

  it("describes seed_and_prompt + parallel scatter", () => {
    const lines = usageLimitLines({ ...VALID, voice: "seed_and_prompt", scatter_native_audio: true });
    expect(lines).toContain("Same seed + same voice lock on every shot");
    expect(lines).toContain("Shots render in parallel; this door cannot hear the previous clip");
  });

  it("describes prev_clip + no scatter", () => {
    const lines = usageLimitLines({
      ...VALID,
      voice: "prev_clip",
      scatter_native_audio: false,
    });
    expect(lines).toContain("Each talking shot continues the previous clip's audio");
    expect(lines).toContain("Talking shots stay on one film (no scatter)");
  });

  it("describes prompt_lock as a lock with no speaker id", () => {
    const lines = usageLimitLines(VALID);
    expect(lines).toContain("Same voice lock on every shot (no speaker id on this door)");
  });

  it("names Cast TTS on a silent door and first+last when declared", () => {
    const lines = usageLimitLines({
      ...VALID,
      native_audio: false,
      voice: "cast_tts",
      first_last: true,
    });
    expect(lines).toContain("Silent motion; speaking voice is the Cast voice (TTS)");
    expect(lines).toContain("Each shot animates toward the next still");
    expect(lines.some((l) => /voice lock/i.test(l))).toBe(false);
  });
});

describe("validateManifest usage", () => {
  const base = { name: "m", version: "1.0.0", api: MODULE_API, hooks: ["motion.backend"] };

  it("accepts absent usage (legacy undeclared) and a valid block", () => {
    expect(typeof validateManifest(base)).toBe("object");
    expect(typeof validateManifest({ ...base, usage: VALID })).toBe("object");
  });

  it("refuses a present-but-invalid usage at LOAD", () => {
    const r = validateManifest({ ...base, usage: { ...VALID, voice: "invented" } });
    expect(typeof r).toBe("string");
    expect(String(r)).toMatch(/usage/);
    expect(String(r)).toMatch(/MotionUsageDecl/);
  });
});
