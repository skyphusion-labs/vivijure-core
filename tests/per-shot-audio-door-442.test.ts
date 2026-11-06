// vivijure-core#442: a per-shot door map whose shots mix a door driven by audio with a silent door.
//
// Before this, the map was an argument of startFilmFromKeyframes only, and pre-clip dialogue was
// decided from the film's default door alone. So a driven default lost the map after pre-clip
// dialogue (every clip went to the default door), and a silent default with a driven mapped shot
// never bought that shot's audio. vivijure-cf#1289 refused both shapes with a 400 until this landed.
//
// These tests drive the real orchestrator (startFilmFromKeyframes, then advanceFilmJob ticks) over
// fake module fetchers and a fake R2. What is faked: storage, presigning and the module HTTP
// replies. What is real: door resolution, the pre-clip dialogue phase, silence minting, the clip
// start and the duration gate.

import { describe, expect, it } from "vitest";
import { advanceFilmJob, startFilmFromKeyframes, type FilmJob } from "../src/film-orchestrator.js";
import { filmJobDocKey } from "../src/film-model.js";
import { mintSilenceWav } from "../src/wav-duration.js";
import { MODULE_API, type MotionUsageDecl, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import { installVfFetch, vfAsyncFinish } from "./install-vf-fetch.js";

const DRIVEN: MotionUsageDecl = {
  native_audio: false,
  voice: "cast_tts",
  scatter_native_audio: false,
  min_seconds: 3,
  max_seconds: 15,
  driving_audio: true,
};

const SILENT: MotionUsageDecl = {
  native_audio: false,
  voice: "cast_tts",
  scatter_native_audio: false,
  min_seconds: 3,
  max_seconds: 15,
  driving_audio: false,
};

const PROJECT = "film";

function mod(over: Partial<RegisteredModule> & { name: string; binding: string; hooks: RegisteredModule["hooks"] }): RegisteredModule {
  return { version: "1.0.0", api: MODULE_API, config_schema: {}, ...over } as RegisteredModule;
}

const dlgMod = mod({ name: "dialogue-gen", binding: "MODULE_DIALOGUE", hooks: ["dialogue"] });
const finishMod = mod({ name: "finish-rife", binding: "MODULE_FINISH", hooks: ["finish"], ui: { order: 10, section: "finish" } });

function motionMod(name: string, binding: string, usage: MotionUsageDecl, order: number): RegisteredModule {
  return mod({
    name, binding, hooks: ["motion.backend"], usage,
    config_schema: { mode: { type: "string", default: "base" } } as RegisteredModule["config_schema"],
    ui: { order, section: "motion", locality: "cloud" },
  });
}

const drivenDoor = motionMod("talker", "MODULE_TALKER", DRIVEN, 1);
const silentDoor = motionMod("plain", "MODULE_PLAIN", SILENT, 2);

// Four shots, one of each kind: driven + line, driven + no line, silent + line, silent + no line.
const SCENES = [
  { shot_id: "shot_01", prompt: "a", seconds: 6 },
  { shot_id: "shot_02", prompt: "b", seconds: 6 },
  { shot_id: "shot_03", prompt: "c", seconds: 6 },
  { shot_id: "shot_04", prompt: "d", seconds: 6 },
];
const LINES = [
  { shot_id: "shot_01", text: "Driven and spoken.", voice_id: "asteria" },
  { shot_id: "shot_03", text: "Silent door, spoken line.", voice_id: "asteria" },
];
// shot_03 is short, so a normalize would pad it to LINE_WAV_MIN_SECONDS; a silent door must not.
const LINE_SECONDS: Record<string, number> = { shot_01: 4, shot_03: 1.5 };

interface MotionCall { door: string; shot_id: string; audio_url?: string; audio_key?: string; seconds: number; config: Record<string, unknown> }

function harness(opts: { motionDone?: boolean } = {}) {
  const store = new Map<string, string | Uint8Array>();
  const motion: MotionCall[] = [];
  const dialogue: string[][] = [];
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
      const body = init?.body ? JSON.parse(String(init.body)) as { input?: MotionCall; config?: Record<string, unknown> } : {};
      const input = body.input;
      if (!input?.shot_id) return new Response("no", { status: 404 });
      motion.push({ door: m.name, shot_id: input.shot_id, audio_url: input.audio_url, audio_key: input.audio_key, seconds: input.seconds, config: body.config ?? {} });
      if (!opts.motionDone) return jsonResp({ ok: true, pending: true, poll: `clip-${input.shot_id}` });
      return jsonResp({ ok: true, output: { shot_id: input.shot_id, clip_key: `renders/${PROJECT}/clips/${input.shot_id}.mp4`, fps: 24, frames: 96 } });
    },
  });
  const env: Record<string, unknown> = {
    PRESIGNER: {
      presignGet: async (key: string) => `https://presigned/${key}`,
      presignPut: async (key: string) => `https://presigned-put/${key}`,
    },
    R2_RENDERS: r2,
    MODULE_TALKER: door(drivenDoor),
    MODULE_PLAIN: door(silentDoor),
    MODULE_FINISH: { fetch: async (url: string) => (String(url).endsWith("/module.json") ? jsonResp(finishMod) : jsonResp({ ok: true, pending: true, poll: "fin" })) },
    MODULE_DIALOGUE: {
      fetch: async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/module.json")) return jsonResp(dlgMod);
        if (!String(url).endsWith("/invoke")) return new Response("no", { status: 404 });
        const body = JSON.parse(String(init?.body)) as { input: { lines: { shot_id: string }[] } };
        const ids = body.input.lines.map((l) => l.shot_id);
        dialogue.push(ids);
        for (const id of ids) await r2.put(`renders/${PROJECT}/dialogue/${id}.wav`, mintSilenceWav(LINE_SECONDS[id] ?? 4));
        return jsonResp({
          ok: true,
          output: {
            project: PROJECT,
            applied: ["dialogue-gen"],
            audio: ids.map((shot_id) => ({ shot_id, audio_key: `renders/${PROJECT}/dialogue/${shot_id}.wav`, voice_id: "asteria", duration_s: LINE_SECONDS[shot_id] ?? 4 })),
          },
        });
      },
    },
  };
  const modules = [dlgMod, drivenDoor, silentDoor, finishMod];
  const read = (id: string) => JSON.parse(store.get(filmJobDocKey(id)) as string) as FilmJob;
  return { env: env as unknown as Env, store, motion, dialogue, modules, read };
}

function start(h: ReturnType<typeof harness>, motion_backend: string, per_shot_motion: Record<string, string>) {
  return startFilmFromKeyframes(h.env, {
    project: PROJECT,
    bundle_key: "bundles/film.tar.gz",
    scenes: SCENES,
    keyframes: SCENES.map((s) => ({ shot_id: s.shot_id, keyframe_key: `renders/${PROJECT}/keyframes/${s.shot_id}.png` })),
    derive_mode: "cloud-finalized",
    motion_backend,
    per_shot_motion,
    motion_configs: { plain: { mode: "per-door" }, talker: { mode: "talk" } },
    dialogue_lines: LINES,
  }, h.modules);
}

const silenceKey = (shot: string) => `renders/${PROJECT}/dialogue/${shot}.wav`;

/** The shared expectation for both mixed shapes: each shot rendered as it would be on its own door. */
function expectPerDoorClips(h: ReturnType<typeof harness>) {
  const byShot = new Map(h.motion.map((c) => [c.shot_id, c]));
  expect([...byShot.keys()].sort()).toEqual(["shot_01", "shot_02", "shot_03", "shot_04"]);
  // Each shot went to its own door, with that door's own config.
  expect(byShot.get("shot_01")).toMatchObject({ door: "talker", config: { mode: "talk" } });
  expect(byShot.get("shot_02")).toMatchObject({ door: "talker", config: { mode: "talk" } });
  expect(byShot.get("shot_03")).toMatchObject({ door: "plain", config: { mode: "per-door" } });
  expect(byShot.get("shot_04")).toMatchObject({ door: "plain", config: { mode: "per-door" } });
  // Driven + line: its line, and the clip follows the line (secondsForShot keeps the longer board).
  expect(byShot.get("shot_01")!.audio_url).toBe(`https://presigned/${silenceKey("shot_01")}`);
  // Driven + no line: minted silence.
  expect(byShot.get("shot_02")!.audio_url).toBe(`https://presigned/${silenceKey("shot_02")}`);
  expect(h.store.get(silenceKey("shot_02"))).toBeInstanceOf(Uint8Array);
  // Silent door, line or not: no audio to the door, board seconds, and no silence minted for it.
  for (const s of ["shot_03", "shot_04"]) {
    expect(byShot.get(s)!.audio_url).toBeUndefined();
    expect(byShot.get(s)!.audio_key).toBeUndefined();
    expect(byShot.get(s)!.seconds).toBe(6);
  }
  expect(h.store.has(silenceKey("shot_04"))).toBe(false);
  // Both lines were bought once, before clips, so lip-sync on the silent door still has its line.
  expect(h.dialogue).toEqual([["shot_01", "shot_03"]]);
}

describe("per-shot door map with an audio-driven door (core#442)", () => {
  it("driven default door, silent mapped shots: the map survives pre-clip dialogue", async () => {
    const h = harness();
    const job = await start(h, "talker", { shot_03: "plain", shot_04: "plain" });
    expect(job.phase).toBe("pre_clip_dialogue");
    expect(h.motion).toHaveLength(0);
    const doc = h.read(job.film_id);
    expect(doc.per_shot_motion).toEqual({ shot_03: "plain", shot_04: "plain" });
    expect(doc.motion_configs).toEqual({ plain: { mode: "per-door" }, talker: { mode: "talk" } });
    const advanced = await advanceFilmJob(h.env, job.film_id, h.modules);
    expect(advanced?.job.phase).toBe("clips");
    expectPerDoorClips(h);
    expect(advanced?.job.dialogue_audio?.shot_03).toBe(silenceKey("shot_03"));
    // The silent-door line is kept as bought (not padded), as the post-clip leg on that door keeps it.
    expect(advanced?.job.dialogue_audio_seconds?.shot_03).toBe(1.5);
    expect((h.store.get(silenceKey("shot_03")) as Uint8Array).byteLength).toBe(mintSilenceWav(1.5).byteLength);
  });

  it("silent default door, driven mapped shots: pre-clip dialogue runs and the driven shots get audio", async () => {
    const h = harness();
    const job = await start(h, "plain", { shot_01: "talker", shot_02: "talker" });
    expect(job.phase).toBe("pre_clip_dialogue");
    expect(h.motion).toHaveLength(0);
    const advanced = await advanceFilmJob(h.env, job.film_id, h.modules);
    expect(advanced?.job.phase).toBe("clips");
    expectPerDoorClips(h);
  });

  it("after clips, the bought lines are not bought again", async () => {
    const h = harness({ motionDone: true });
    const job = await start(h, "plain", { shot_01: "talker", shot_02: "talker" });
    await advanceFilmJob(h.env, job.film_id, h.modules); // pre-clip dialogue -> clips (done at submit)
    const after = await advanceFilmJob(h.env, job.film_id, h.modules); // clips -> finish
    expect(after?.job.phase).toBe("finish");
    expect(h.dialogue).toHaveLength(1);
  });

  it("CONTROL: a map with no driven door starts clips at once, on the mapped doors, with no audio", async () => {
    const h = harness();
    const twoSilent = { ...silentDoor, name: "plain2", binding: "MODULE_PLAIN" } as RegisteredModule;
    h.modules.push(twoSilent);
    const job = await start(h, "plain", { shot_01: "plain2" });
    expect(job.phase).toBe("clips");
    expect(h.dialogue).toHaveLength(0);
    expect(h.motion.every((c) => c.audio_url === undefined)).toBe(true);
    expect(h.read(job.film_id).per_shot_motion).toEqual({ shot_01: "plain2" });
  });

  it("CONTROL: a film on one driven door still gives every shot audio (single-door path unchanged)", async () => {
    const h = harness();
    const job = await start(h, "talker", {});
    expect(h.read(job.film_id).per_shot_motion).toBeUndefined();
    await advanceFilmJob(h.env, job.film_id, h.modules);
    expect(h.motion).toHaveLength(4);
    expect(h.motion.every((c) => c.door === "talker" && typeof c.audio_url === "string")).toBe(true);
  });
});

// The duration gate reads each shot's own door (vivijure-cf#1142 extended by core#442).
describe("duration gate on a mixed film (core#442)", () => {
  const FILM = "film-gate-442";
  const OUT = `renders/${FILM}/film.mp4`;

  async function assemble(delivered: [number, number]) {
    let stored = JSON.stringify({
      film_id: FILM, project: "p", phase: "assemble", created_at: 0, motion_backend: "plain",
      per_shot_motion: { shot_01: "talker" },
      scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 6 }, { shot_id: "shot_02", prompt: "y", seconds: 6 }],
      finish_shots: [
        { shot_id: "shot_01", clip_key: `renders/${FILM}/shots/shot_01.mp4`, status: "done" },
        { shot_id: "shot_02", clip_key: `renders/${FILM}/shots/shot_02.mp4`, status: "done" },
      ],
      dialogue_audio_seconds: { shot_01: 3, shot_02: 3 },
    });
    const env = {
      R2_RENDERS: {
        get: async (key: string) => (key === filmJobDocKey(FILM) ? { text: async () => stored } : null),
        head: async (key: string) => (key === filmJobDocKey(FILM) ? { size: 4096 } : null),
        put: async (key: string, val: string) => { if (key === filmJobDocKey(FILM)) stored = val; },
      },
      PRESIGNER: {
        presignGet: async (key: string) => `https://presigned/${key}`,
        presignPut: async (key: string) => `https://presigned-put/${key}`,
      },
      VIDEO_FINISH_URL: "https://video-finish.test",
      MEDIA_FINISH_TOKEN: "test-tok",
    };
    installVfFetch(vfAsyncFinish({ ok: true, key: OUT, durationSeconds: delivered[0] + delivered[1], shots: 2, clipDurations: delivered }));
    const r = await advanceFilmJob(env as unknown as Env, FILM, [drivenDoor, silentDoor]);
    return r?.job as FilmJob;
  }

  it("passes a driven shot that follows its short line, with a silent shot at full length", async () => {
    const job = await assemble([2.96, 6]);
    expect(job.error ?? "").not.toContain("duration gate");
  });

  it("fails a silent-door shot as short as its line: that door was asked for the board", async () => {
    const job = await assemble([2.96, 2.96]);
    expect(job.phase).toBe("failed");
    expect(job.error).toContain("duration gate");
    expect(job.error).toContain("shot_02");
    expect(job.error).not.toContain("shot_01");
  });
});
