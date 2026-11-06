import { describe, it, expect } from "vitest";
import { installVfFetch, vfAsyncFinish } from "./install-vf-fetch.js";
import {
  advanceFilmJob,
  assembleHoldSeconds,
  drivenLineFloorSeconds,
  filmJobDocKey,
  type FilmJob,
} from "../src/film-orchestrator.js";
import { doorBillsPerClip } from "../src/motion-usage.js";
import { MODULE_API, type MotionUsageDecl, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#1338. A shot keeps its planned length on every driven door, by the cheapest means that door
// allows. A door that bills per clip (ui.cost_usd_per_clip) gets its line padded to the planned seconds
// before it renders. A door that bills by length gets no pad, because the pad would be billed: assembly
// holds its clip's last frame to the planned seconds instead. Measured on InfiniteTalk (cf#1338): a shot
// planned at 2s delivered 0.36s once the 3s pad of core#464 was gone.

const DRIVEN: MotionUsageDecl = {
  native_audio: false, voice: "cast_tts", scatter_native_audio: false, min_seconds: 1, max_seconds: 15, driving_audio: true,
};
const SILENT: MotionUsageDecl = { native_audio: false, voice: "prompt_lock", scatter_native_audio: true, min_seconds: 2, max_seconds: 8 };

function door(name: string, usage: MotionUsageDecl, ui: Record<string, unknown> = {}): RegisteredModule {
  return {
    name, version: "1.0.0", api: MODULE_API, hooks: ["motion.backend"], binding: `MODULE_${name.toUpperCase().replace(/-/g, "_")}`,
    usage, ui: { section: "motion", order: 10, locality: "cloud", ...ui },
  } as RegisteredModule;
}
// Shapes copied from the real manifests (vivijure-cf main): infinitetalk `cost_usd_per_clip: [{ usd: 0.25 }]`,
// cf-p-video-avatar `cost_usd_per_second: [0.025, 0.045]`.
const PER_CLIP = door("infinitetalk", DRIVEN, { cost_usd_per_clip: [{ usd: 0.25 }] });
const PER_SECOND = door("cf-p-video-avatar", DRIVEN, { cost_usd_per_second: [0.025, 0.045] });
const SHORT_CAP = door("short-door", { ...DRIVEN, max_seconds: 4 }, { cost_usd_per_second: [0.1] });
const SILENT_DOOR = door("silent-door", SILENT);

describe("cf#1338 the rule, per door", () => {
  it("a per-clip price is read from the manifest; anything else bills by length", () => {
    expect(doorBillsPerClip(PER_CLIP)).toBe(true);
    expect(doorBillsPerClip(PER_SECOND)).toBe(false);
    expect(doorBillsPerClip(SILENT_DOOR)).toBe(false);
    expect(doorBillsPerClip(door("bad", DRIVEN, { cost_usd_per_clip: [{ usd: "0.25" }] }))).toBe(false);
    expect(doorBillsPerClip(door("bare", DRIVEN, { cost_usd_per_clip: [0.25] }))).toBe(false);
    expect(doorBillsPerClip(door("empty", DRIVEN, { cost_usd_per_clip: [] }))).toBe(false);
    // A price per duration step costs more for a longer clip, so its line is not padded.
    expect(doorBillsPerClip(door("stepped", DRIVEN, { cost_usd_per_clip: [{ usd: 0.5, seconds: 5 }, { usd: 1, seconds: 10 }] }))).toBe(false);
    // A price per resolution is still a flat price per clip.
    expect(doorBillsPerClip(door("by-res", DRIVEN, { cost_usd_per_clip: [{ usd: 0.25, resolution: "480p" }, { usd: 0.5, resolution: "720p" }] }))).toBe(true);
  });

  it("a per-clip door pads the line to the planned seconds; a per-second door does not", () => {
    expect(drivenLineFloorSeconds(DRIVEN, true, 2)).toBe(2);
    expect(drivenLineFloorSeconds(DRIVEN, false, 2)).toBe(0);
    // The door's own floor still applies, and the larger wins.
    expect(drivenLineFloorSeconds({ ...DRIVEN, driving_audio_min_seconds: 3 }, false, 2)).toBe(3);
    expect(drivenLineFloorSeconds({ ...DRIVEN, driving_audio_min_seconds: 3 }, true, 5)).toBe(5);
    // Never past the door's max_seconds, and never on a door that is not driven by audio.
    expect(drivenLineFloorSeconds({ ...DRIVEN, max_seconds: 4 }, true, 9)).toBe(4);
    expect(drivenLineFloorSeconds(SILENT, true, 5)).toBe(0);
  });

  it("only a driven door that bills by length gets a hold, never past max_seconds", () => {
    expect(assembleHoldSeconds(DRIVEN, false, 2)).toBe(2);
    expect(assembleHoldSeconds(DRIVEN, true, 2)).toBeUndefined();
    expect(assembleHoldSeconds(SILENT, false, 2)).toBeUndefined();
    expect(assembleHoldSeconds({ ...DRIVEN, max_seconds: 4 }, false, 9)).toBe(4);
    expect(assembleHoldSeconds(DRIVEN, false, 0)).toBeUndefined();
  });
});

// ---- at the seam: what the container is actually sent.
const FILM = "film-cf1338";
const OUT = `renders/${FILM}/film.mp4`;
const SHOTS: Array<[string, string, number]> = [
  ["shot_01", "cf-p-video-avatar", 2],
  ["shot_02", "infinitetalk", 2],
  ["shot_03", "silent-door", 2],
  ["shot_04", "short-door", 9],
];

function seam() {
  const job = {
    film_id: FILM, project: "p", phase: "assemble" as const, created_at: 0,
    motion_backend: "cf-p-video-avatar",
    per_shot_motion: Object.fromEntries(SHOTS.map(([id, d]) => [id, d])),
    scenes: SHOTS.map(([shot_id, , seconds]) => ({ shot_id, prompt: "x", seconds })),
    finish_shots: SHOTS.map(([shot_id]) => ({ shot_id, clip_key: `renders/${FILM}/shots/${shot_id}.mp4`, status: "done" })),
  };
  let stored = JSON.stringify(job);
  let finished = false;
  const bodies: Array<{ clips: Array<{ url: string; holdToSeconds?: number }> }> = [];
  const env = {
    R2_RENDERS: {
      get: async (key: string) => (key === filmJobDocKey(FILM) ? { text: async () => stored } : null),
      head: async (key: string) => (key === filmJobDocKey(FILM) ? { size: 1 } : key === OUT && finished ? { size: 4096 } : null),
      put: async (key: string, val: string) => { if (key === filmJobDocKey(FILM)) stored = val; },
      delete: async () => undefined,
    },
    PRESIGNER: {
      presignGet: async (key: string) => `https://presigned/${key}`,
      presignPut: async (key: string) => `https://presigned-put/${key}`,
    },
    VIDEO_FINISH_URL: "https://video-finish.test",
    MEDIA_FINISH_TOKEN: "test-tok",
  } as unknown as Env;
  const asyncVf = vfAsyncFinish({ ok: true, key: OUT, durationSeconds: 15, shots: 4, clipDurations: [2, 2, 2, 4] });
  installVfFetch(async (url, init) => {
    if (String(url).includes("/async/finish")) {
      finished = true;
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
    }
    return asyncVf(url, init);
  });
  return { env, bodies, read: () => JSON.parse(stored) as FilmJob };
}

describe("cf#1338 at the seam: the assemble request carries the hold", () => {
  it("each shot's clip carries the hold its own door calls for", async () => {
    const h = seam();
    await advanceFilmJob(h.env, FILM, [PER_CLIP, PER_SECOND, SHORT_CAP, SILENT_DOOR]);
    expect(h.bodies.length).toBeGreaterThanOrEqual(1);
    const byShot = Object.fromEntries(
      h.bodies[0].clips.map((c) => [c.url.match(/shots\/(shot_\d+)\.mp4/)![1], c.holdToSeconds]),
    );
    expect(byShot).toEqual({
      shot_01: 2,          // per-second driven door: held to the plan, the line was not padded
      shot_02: undefined,  // per-clip driven door: its line was padded instead, so no hold
      shot_03: undefined,  // a silent door: unchanged
      shot_04: 4,          // planned 9s, held only to the door's max_seconds of 4
    });
  });
});
