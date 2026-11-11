// vivijure-cf#930, Conrad's ruling 2026-11-11: a per-shot motion door applies to that one clip only, and
// the film door stays the default for every other shot. A lined shot whose film door's clip floor would
// leave the speaker mouthing silence after the line moves to the first door the caller offered that takes
// it without a tail. Only per_shot_motion changes; motion_backend never does.
//
// The orchestrator cases drive the real startFilmFromKeyframes and advanceFilmJob over fake module
// fetchers and a fake R2, as tests/per-shot-audio-door-442.test.ts does. What is faked: storage,
// presigning and the module HTTP replies. What is real: door resolution, pre-clip dialogue, the door fit,
// the line normalize and the clip start.

import { describe, expect, it } from "vitest";
import { advanceFilmJob, startFilmFromKeyframes, type FilmJob } from "../src/film-orchestrator.js";
import { filmJobDocKey } from "../src/film-model.js";
import { filmDonePayload } from "../src/render-output-payload.js";
import { naturalKeyForStartFromKeyframes } from "../src/film-submit-idempotency.js";
import { clipSecondsOnDoor, doorTailSeconds, pickFitDoor } from "../src/door-fit.js";
import { mintSilenceWav } from "../src/wav-duration.js";
import { MODULE_API, type MotionUsageDecl, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// alibaba-wan's shape: driven, priced by length, 5/10/15 s steps, a 3 s audio floor.
const WAN: MotionUsageDecl = {
  native_audio: true, voice: "cast_tts", scatter_native_audio: false,
  min_seconds: 5, max_seconds: 15, duration_steps: [5, 10, 15], driving_audio: true, driving_audio_min_seconds: 3,
};
// infinitetalk's shape: driven, one price per clip, sizes its clip from the line.
const TALK: MotionUsageDecl = {
  native_audio: false, voice: "cast_tts", scatter_native_audio: false,
  min_seconds: 2, max_seconds: 15, driving_audio: true, driving_audio_min_seconds: 2,
};
const SILENT: MotionUsageDecl = {
  native_audio: false, voice: "cast_tts", scatter_native_audio: false,
  min_seconds: 1, max_seconds: 15, driving_audio: false,
};

const PROJECT = "film";

function mod(over: Partial<RegisteredModule> & { name: string; binding: string; hooks: RegisteredModule["hooks"] }): RegisteredModule {
  return { version: "1.0.0", api: MODULE_API, config_schema: {}, ...over } as RegisteredModule;
}
function motionMod(name: string, binding: string, usage: MotionUsageDecl, order: number, ui: Record<string, unknown> = {}, schema: RegisteredModule["config_schema"] = {}): RegisteredModule {
  return mod({ name, binding, hooks: ["motion.backend"], usage, config_schema: schema, ui: { order, section: "motion", locality: "cloud", ...ui } as RegisteredModule["ui"] });
}

const wan = motionMod("wan", "MODULE_WAN", WAN, 1, { cost_usd_per_second: [0.1, 0.15] });
const talk = motionMod("talk", "MODULE_TALK", TALK, 2, { cost_usd_per_clip: [{ usd: 0.3 }] }, {
  steps: { type: "int", default: 4, min: 1, max: 10 },
} as unknown as RegisteredModule["config_schema"]);
const plain = motionMod("plain", "MODULE_PLAIN", SILENT, 3);
// A per-clip driven door that refuses short shots at its default resolution (core#507 `requires`).
const picky = motionMod("picky", "MODULE_PICKY", TALK, 4, { cost_usd_per_clip: [{ usd: 0.3 }] }, {
  resolution: { type: "enum", values: ["720p", "1080p"], default: "1080p", requires: [{ when: "1080p", shot_seconds: { min: 7.5 } }] },
} as unknown as RegisteredModule["config_schema"]);
const dlgMod = mod({ name: "dialogue-gen", binding: "MODULE_DIALOGUE", hooks: ["dialogue"] });

// shot_01: planned 2 s, line 1.4 s. Wan rounds the clip up to 5 s, the line covers 3 s: a 2 s tail the door made.
// shot_02: planned 10 s, line 9 s. Wan makes 10 s, the plan's own length: no tail from the door.
// shot_03: planned 3 s, line 1 s, and the caller gave it Wan itself: never moved, the tail is recorded.
// shot_04: no line.
const SCENES = [
  { shot_id: "shot_01", prompt: "a", seconds: 2 },
  { shot_id: "shot_02", prompt: "b", seconds: 10 },
  { shot_id: "shot_03", prompt: "c", seconds: 3 },
  { shot_id: "shot_04", prompt: "d", seconds: 5 },
];
const LINES = [
  { shot_id: "shot_01", text: "Short.", voice_id: "asteria" },
  { shot_id: "shot_02", text: "A long line that runs most of the shot.", voice_id: "asteria" },
  { shot_id: "shot_03", text: "Hi.", voice_id: "asteria" },
];
const LINE_SECONDS: Record<string, number> = { shot_01: 1.4, shot_02: 9, shot_03: 1 };

interface MotionCall { door: string; shot_id: string; config: Record<string, unknown> }

function harness(extra: RegisteredModule[] = []) {
  const store = new Map<string, string | Uint8Array>();
  const motion: MotionCall[] = [];
  const jsonResp = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
  const r2 = {
    async put(key: string, value: string | Uint8Array) { store.set(key, value); },
    async get(key: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
      return {
        text: async () => (typeof v === "string" ? v : new TextDecoder().decode(v)),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
    async head() { return null; },
    async list() { return { objects: [], truncated: false }; },
  };
  const door = (m: RegisteredModule) => ({
    fetch: async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/module.json")) return jsonResp(m);
      if (String(url).endsWith("/poll")) return jsonResp({ ok: true, pending: true });
      const body = init?.body ? JSON.parse(String(init.body)) as { input?: { shot_id: string }; config?: Record<string, unknown> } : {};
      if (!body.input?.shot_id) return new Response("no", { status: 404 });
      motion.push({ door: m.name, shot_id: body.input.shot_id, config: body.config ?? {} });
      return jsonResp({ ok: true, pending: true, poll: `clip-${body.input.shot_id}` });
    },
  });
  const doors = [wan, talk, plain, picky, ...extra];
  const env: Record<string, unknown> = {
    PRESIGNER: { presignGet: async (k: string) => `https://presigned/${k}`, presignPut: async (k: string) => `https://presigned-put/${k}` },
    R2_RENDERS: r2,
    MODULE_DIALOGUE: {
      fetch: async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/module.json")) return jsonResp(dlgMod);
        if (!String(url).endsWith("/invoke")) return new Response("no", { status: 404 });
        const ids = (JSON.parse(String(init?.body)) as { input: { lines: { shot_id: string }[] } }).input.lines.map((l) => l.shot_id);
        for (const id of ids) await r2.put(`renders/${PROJECT}/dialogue/${id}.wav`, mintSilenceWav(LINE_SECONDS[id] ?? 4));
        return jsonResp({ ok: true, output: { project: PROJECT, applied: ["dialogue-gen"], audio: ids.map((shot_id) => ({ shot_id, audio_key: `renders/${PROJECT}/dialogue/${shot_id}.wav`, voice_id: "asteria", duration_s: LINE_SECONDS[shot_id] ?? 4 })) } });
      },
    },
  };
  for (const d of doors) env[d.binding] = door(d);
  const modules = [dlgMod, ...doors];
  const read = (id: string) => JSON.parse(store.get(filmJobDocKey(id)) as string) as FilmJob;
  return { env: env as unknown as Env, motion, modules, read };
}

async function run(h: ReturnType<typeof harness>, door_fit: string[] | undefined) {
  const job = await startFilmFromKeyframes(h.env, {
    project: PROJECT,
    bundle_key: "bundles/film.tar.gz",
    scenes: SCENES,
    keyframes: SCENES.map((s) => ({ shot_id: s.shot_id, keyframe_key: `renders/${PROJECT}/keyframes/${s.shot_id}.png` })),
    derive_mode: "finalized",
    motion_backend: "wan",
    per_shot_motion: { shot_03: "wan" },
    motion_configs: { talk: { steps: 7 } },
    dialogue_lines: LINES,
    ...(door_fit ? { door_fit } : {}),
  }, h.modules);
  expect(job.phase).toBe("pre_clip_dialogue");
  const advanced = await advanceFilmJob(h.env, job.film_id, h.modules);
  expect(advanced?.job.phase).toBe("clips");
  return h.read(job.film_id);
}

describe("door fit: a lined shot moves off a door whose floor leaves a tail (cf#930)", () => {
  it("moves only that shot, to the first offered door, with that door's config; the film door is unchanged", async () => {
    const h = harness();
    const doc = await run(h, ["talk"]);
    expect(doc.motion_backend).toBe("wan");
    expect(doc.per_shot_motion).toEqual({ shot_01: "talk", shot_03: "wan" });
    const byShot = new Map(h.motion.map((c) => [c.shot_id, c]));
    expect(byShot.get("shot_01")).toMatchObject({ door: "talk", config: { steps: 7 } });
    for (const s of ["shot_02", "shot_03", "shot_04"]) expect(byShot.get(s)?.door).toBe("wan");
    // The moved line is padded for its NEW door: to the 2 s plan on a per-clip door, not to Wan's 3 s floor.
    expect(doc.dialogue_audio_seconds?.shot_01).toBe(2);
    expect(doc.door_fit).toEqual({
      swapped: [{ shot_id: "shot_01", from: "wan", to: "talk", line_seconds: 1.4, planned_seconds: 2, from_clip_seconds: 5 }],
      tails: [{ shot_id: "shot_03", door: "wan", line_seconds: 1, clip_seconds: 5 }],
    });
    // The render row carries the record.
    expect(filmDonePayload(doc, null).door_fit).toEqual(doc.door_fit);
  });

  it("with no offer, nothing moves and every tail is recorded", async () => {
    const h = harness();
    const doc = await run(h, undefined);
    expect(doc.per_shot_motion).toEqual({ shot_03: "wan" });
    expect(h.motion.every((c) => c.door === "wan")).toBe(true);
    expect(doc.door_fit?.swapped).toEqual([]);
    expect(doc.door_fit?.tails.map((t) => t.shot_id)).toEqual(["shot_01", "shot_03"]);
  });

  it("skips an offered door that refuses the shot (requires) or leaves its own tail, and takes the next", async () => {
    const wan2 = motionMod("wan2", "MODULE_WAN2", WAN, 5, { cost_usd_per_second: [0.1] });
    const h = harness([wan2]);
    const doc = await run(h, ["wan2", "picky", "plain", "talk"]);
    expect(doc.door_fit?.swapped.map((s) => s.to)).toEqual(["talk"]);
  });

  it("records the tail when no offered door fits", async () => {
    const h = harness();
    const doc = await run(h, ["picky", "plain"]);
    expect(doc.per_shot_motion).toEqual({ shot_03: "wan" });
    expect(doc.door_fit?.tails.map((t) => t.shot_id)).toEqual(["shot_01", "shot_03"]);
  });

  it("runs once: a later tick does not re-decide or drop the record", async () => {
    const h = harness();
    const doc = await run(h, ["talk"]);
    await advanceFilmJob(h.env, doc.film_id, h.modules);
    const again = h.read(doc.film_id);
    expect(again.door_fit).toEqual(doc.door_fit);
    expect(again.per_shot_motion).toEqual(doc.per_shot_motion);
  });
});

describe("door fit: the pure rules (cf#930)", () => {
  it("a stepped door rounds the clip up; a ranged door clamps", () => {
    expect(clipSecondsOnDoor(WAN, 1.4)).toBe(5);
    expect(clipSecondsOnDoor(WAN, 6)).toBe(10);
    expect(clipSecondsOnDoor(WAN, 20)).toBe(15);
    expect(clipSecondsOnDoor(TALK, 1)).toBe(2);
    expect(clipSecondsOnDoor(TALK, 20)).toBe(15);
  });

  it("only a by-length driven door whose floor runs past the plan and the line has a tail", () => {
    expect(doorTailSeconds(wan, 1.4, 2)).toEqual({ tail: 2, clip: 5 });
    expect(doorTailSeconds(wan, 9, 10).tail).toBe(0); // the plan's own length
    expect(doorTailSeconds(wan, 4.8, 4.8).tail).toBe(0); // within the half-second rounding
    expect(doorTailSeconds(talk, 1.4, 2).tail).toBe(0); // per clip: its line is padded to the plan
    expect(doorTailSeconds(plain, 1.4, 2).tail).toBe(0); // not driven
  });

  it("never picks the film door or a door that is not serving", () => {
    expect(pickFitDoor(["wan", "ghost"], [wan, talk], "wan", 1.4, 2, () => true)).toBeUndefined();
  });

  it("CONTROL: a submit with no offer keeps its old idempotency key; an offer changes it", () => {
    const base = { project: "p", bundle_key: "b", scenes: [], keyframes: [], derive_mode: "finalized" as const };
    const plainKey = JSON.stringify(naturalKeyForStartFromKeyframes(base));
    expect(JSON.stringify(naturalKeyForStartFromKeyframes({ ...base, door_fit: [] }))).toBe(plainKey);
    expect(JSON.stringify(naturalKeyForStartFromKeyframes({ ...base, door_fit: ["talk"] }))).not.toBe(plainKey);
  });
});
