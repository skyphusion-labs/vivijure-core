import { describe, expect, it } from "vitest";
import { advanceFilmJob, startFilmFromKeyframes, startFilmJob, type FilmJob } from "../src/film-orchestrator.js";
import { filmJobDocKey, POLLABLE_PHASES } from "../src/film-model.js";
import { mintSilenceWav } from "../src/wav-duration.js";
import { MODULE_API, type MotionUsageDecl, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

const USAGE_INFINITETALK: MotionUsageDecl = {
  native_audio: false,
  voice: "cast_tts",
  scatter_native_audio: false,
  min_seconds: 3,
  max_seconds: 15,
  driving_audio: true,
};

const USAGE_WAN: MotionUsageDecl = {
  native_audio: true,
  voice: "cast_tts",
  scatter_native_audio: false,
  min_seconds: 5,
  max_seconds: 15,
  duration_steps: [5, 10, 15],
  driving_audio: true,
};

function mod(over: Partial<RegisteredModule> & { name: string; binding: string; hooks: RegisteredModule["hooks"] }): RegisteredModule {
  return {
    version: "1.0.0",
    api: MODULE_API,
    config_schema: {},
    ...over,
  } as RegisteredModule;
}

const kfMod = mod({ name: "keyframe", binding: "MODULE_KEYFRAME", hooks: ["keyframe"] });
const dlgMod = mod({ name: "dialogue-gen", binding: "MODULE_DIALOGUE", hooks: ["dialogue"] });
const speechMod = mod({ name: "speech-upscale", binding: "MODULE_SPEECH", hooks: ["speech"] });
const finishMod = mod({ name: "finish-rife", binding: "MODULE_FINISH", hooks: ["finish"], ui: { order: 10, section: "finish" } });

function motionMod(name: string, binding: string, usage: MotionUsageDecl): RegisteredModule {
  return mod({ name, binding, hooks: ["motion.backend"], usage, ui: { order: 15, section: "motion", locality: "cloud" } });
}

const SCENES = [
  { shot_id: "shot_01", prompt: "diner talk", seconds: 5 },
  { shot_id: "shot_02", prompt: "wide establishing", seconds: 5 },
];

function jsonResp(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function kfOut(project: string, ids: string[]) {
  return {
    project,
    keyframes: ids.map((shot_id) => ({ shot_id, keyframe_key: `renders/${project}/keyframes/${shot_id}.png` })),
  };
}

interface Harness {
  env: Env;
  read: (filmId: string) => FilmJob;
  store: Map<string, string | Uint8Array>;
  dialogueInvokes: number;
  dialoguePolls: number;
  speechInvokes: number;
  motionInvokes: Array<{ shot_id: string; audio_url?: string; audio_key?: string; voice_ref_url?: string; seconds: number }>;
}

function harness(opts: {
  usage: MotionUsageDecl;
  motionName?: string;
  dialogue?: "pending" | "output" | "fail" | "hole";
  speech?: boolean;
  finish?: boolean;
  motionDone?: boolean;
}): Harness {
  const store = new Map<string, string | Uint8Array>();
  const motionInvokes: Harness["motionInvokes"] = [];
  const h: Harness = {
    env: null as unknown as Env,
    read: (filmId) => {
      const raw = store.get(filmJobDocKey(filmId));
      if (typeof raw !== "string") throw new Error("no film job");
      return JSON.parse(raw) as FilmJob;
    },
    store,
    dialogueInvokes: 0,
    dialoguePolls: 0,
    speechInvokes: 0,
    motionInvokes,
  };
  const project = "film";
  const motionName = opts.motionName ?? (opts.usage.native_audio ? "alibaba-wan" : "infinitetalk");
  const motionBinding = opts.usage.native_audio ? "MODULE_WAN" : "MODULE_INFINITETALK";

  const r2 = {
    async put(key: string, value: string | Uint8Array) {
      store.set(key, typeof value === "string" ? value : value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer));
    },
    async get(key: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (v instanceof Uint8Array) {
        return {
          text: async () => new TextDecoder().decode(v),
          arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
        };
      }
      return {
        text: async () => v,
        arrayBuffer: async () => new TextEncoder().encode(v).buffer,
      };
    },
    async head() { return null; },
    async list() { return { objects: [], truncated: false }; },
  };

  const env: Record<string, unknown> = {
    KEYFRAME_PARALLEL: "1",
    PRESIGNER: {
      presignGet: async (key: string) => `https://presigned/${key}`,
      presignPut: async (key: string) => `https://presigned-put/${key}`,
    },
    R2_RENDERS: r2,
    MODULE_KEYFRAME: {
      fetch: async (url: string) => {
        if (String(url).endsWith("/module.json")) return jsonResp(kfMod);
        return jsonResp({ ok: true, output: kfOut(project, ["shot_01", "shot_02"]) });
      },
    },
    MODULE_DIALOGUE: {
      fetch: async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/module.json")) return jsonResp(dlgMod);
        const body = init?.body ? JSON.parse(String(init.body)) as { input?: { lines?: { shot_id: string }[] } } : {};
        if (String(url).endsWith("/invoke")) {
          h.dialogueInvokes += 1;
          const ids = (body.input?.lines ?? []).map((l) => l.shot_id);
          expect(ids).not.toContain("shot_02"); // lineless shot is not submitted
          if (opts.dialogue === "fail") return jsonResp({ ok: false, error: "aura hung" });
          if (opts.dialogue === "pending") return jsonResp({ ok: true, pending: true, poll: "dlg-poll" });
          const keep = opts.dialogue === "hole" ? ids.filter((id) => id !== "shot_01") : ids;
          for (const id of keep) {
            await r2.put(`renders/${project}/dialogue/${id}.wav`, mintSilenceWav(1.5));
          }
          return jsonResp({
            ok: true,
            output: {
              project,
              applied: ["dialogue-gen"],
              audio: keep.map((shot_id) => ({
                shot_id,
                audio_key: `renders/${project}/dialogue/${shot_id}.wav`,
                voice_id: "asteria",
                duration_s: 1.5,
              })),
            },
          });
        }
        if (String(url).endsWith("/poll")) {
          h.dialoguePolls += 1;
          await r2.put(`renders/${project}/dialogue/shot_01.wav`, mintSilenceWav(1.5));
          return jsonResp({
            ok: true,
            output: {
              project,
              applied: ["dialogue-gen"],
              audio: [{
                shot_id: "shot_01",
                audio_key: `renders/${project}/dialogue/shot_01.wav`,
                voice_id: "asteria",
                duration_s: 1.5,
              }],
            },
          });
        }
        return new Response("no", { status: 404 });
      },
    },
    [motionBinding]: {
      fetch: async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/module.json")) return jsonResp(motionMod(motionName, motionBinding, opts.usage));
        const body = init?.body ? JSON.parse(String(init.body)) as { input?: Harness["motionInvokes"][number] } : {};
        if (body.input?.shot_id) motionInvokes.push({
          shot_id: body.input.shot_id,
          audio_url: body.input.audio_url,
          audio_key: body.input.audio_key,
          voice_ref_url: body.input.voice_ref_url,
          seconds: body.input.seconds,
        });
        const shotId = body.input?.shot_id ?? "shot_01";
        if (!opts.motionDone) {
          return jsonResp({ ok: true, pending: true, poll: `clip-poll-${shotId}` });
        }
        return jsonResp({
          ok: true,
          output: {
            shot_id: shotId,
            clip_key: `renders/${project}/clips/${shotId}.mp4`,
            fps: 24,
            frames: 120,
            has_audio: true,
          },
        });
      },
    },
  };

  if (opts.speech) {
    env.MODULE_SPEECH = {
      fetch: async (url: string) => {
        if (String(url).endsWith("/module.json")) return jsonResp(speechMod);
        h.speechInvokes += 1;
        return jsonResp({
          ok: true,
          output: { shot_id: "shot_01", audio_key: `renders/${project}/dialogue/shot_01.wav`, applied: ["speech-upscale"] },
        });
      },
    };
  }
  if (opts.finish) {
    env.MODULE_FINISH = {
      fetch: async (url: string) => {
        if (String(url).endsWith("/module.json")) return jsonResp(finishMod);
        return jsonResp({ ok: true, pending: true, poll: "fin-poll" });
      },
    };
  }

  h.env = env as unknown as Env;
  return h;
}

function modulesFor(h: Harness, opts: { usage: MotionUsageDecl; speech?: boolean; finish?: boolean }): RegisteredModule[] {
  const motionName = opts.usage.native_audio ? "alibaba-wan" : "infinitetalk";
  const motionBinding = opts.usage.native_audio ? "MODULE_WAN" : "MODULE_INFINITETALK";
  const list = [
    kfMod,
    dlgMod,
    motionMod(motionName, motionBinding, opts.usage),
  ];
  if (opts.speech) list.push(speechMod);
  if (opts.finish) list.push(finishMod);
  return list;
}

const START = {
  project: "film",
  bundle_key: "bundles/film.tar.gz",
  scenes: SCENES,
  dialogue_lines: [
    { shot_id: "shot_01", text: "The pie is a lie.", voice_id: "asteria" },
    { shot_id: "shot_02", text: "   " },
  ],
};

describe("pre_clip_dialogue tick sequence", () => {
  it("keyframe-complete submits TTS and does not start clips on that tick", async () => {
    const h = harness({ usage: USAGE_INFINITETALK, dialogue: "pending" });
    const mods = modulesFor(h, { usage: USAGE_INFINITETALK });
    const job = await startFilmJob(h.env, { ...START, motion_backend: "infinitetalk" }, mods);
    expect(job.phase).toBe("pre_clip_dialogue");
    expect(job.dialogue_poll).toBe("dlg-poll");
    expect(h.dialogueInvokes).toBe(1);
    expect(h.motionInvokes.length).toBe(0);
    expect(h.read(job.film_id).phase).toBe("pre_clip_dialogue");
  });

  it("next tick polls TTS then starts clips; lineless InfiniteTalk gets silence audio_url", async () => {
    const h = harness({ usage: USAGE_INFINITETALK, dialogue: "pending" });
    const mods = modulesFor(h, { usage: USAGE_INFINITETALK });
    const started = await startFilmJob(h.env, { ...START, motion_backend: "infinitetalk" }, mods);
    expect(h.motionInvokes.length).toBe(0);
    const advanced = await advanceFilmJob(h.env, started.film_id, mods);
    expect(advanced?.job.phase).toBe("clips");
    expect(h.dialoguePolls).toBe(1);
    expect(h.motionInvokes.map((m) => m.shot_id).sort()).toEqual(["shot_01", "shot_02"]);
    const lined = h.motionInvokes.find((m) => m.shot_id === "shot_01")!;
    const wide = h.motionInvokes.find((m) => m.shot_id === "shot_02")!;
    expect(lined.audio_url).toBe("https://presigned/renders/film/dialogue/shot_01.wav");
    expect(lined.voice_ref_url).toBeUndefined();
    expect(wide.audio_url).toBe("https://presigned/renders/film/dialogue/shot_02.wav");
    expect(h.store.get("renders/film/dialogue/shot_02.wav")).toBeInstanceOf(Uint8Array);
  });

  it("Wan lineless shots omit audio_url (neighborhood), lined shots carry the LINE file", async () => {
    const h = harness({ usage: USAGE_WAN, dialogue: "output" });
    const mods = modulesFor(h, { usage: USAGE_WAN });
    const started = await startFilmJob(h.env, { ...START, motion_backend: "alibaba-wan" }, mods);
    expect(started.phase).toBe("pre_clip_dialogue");
    expect(h.motionInvokes.length).toBe(0);
    const advanced = await advanceFilmJob(h.env, started.film_id, mods);
    expect(advanced?.job.phase).toBe("clips");
    const lined = h.motionInvokes.find((m) => m.shot_id === "shot_01")!;
    const wide = h.motionInvokes.find((m) => m.shot_id === "shot_02")!;
    expect(lined.audio_url).toMatch(/shot_01\.wav$/);
    expect(wide.audio_url).toBeUndefined();
    expect(wide.audio_key).toBeUndefined();
    expect(lined.seconds).toBeGreaterThanOrEqual(5);
  });

  it("fail-closes a lined TTS hole and does not fail a lineless establishing shot", async () => {
    const hole = harness({ usage: USAGE_WAN, dialogue: "hole" });
    const mods = modulesFor(hole, { usage: USAGE_WAN });
    const started = await startFilmJob(hole.env, { ...START, motion_backend: "alibaba-wan" }, mods);
    const advanced = await advanceFilmJob(hole.env, started.film_id, mods);
    expect(advanced?.job.phase).toBe("failed");
    expect(advanced?.job.error).toMatch(/incomplete film -- dialogue/);
    expect(advanced?.job.error).toMatch(/shot_01/);
    expect(advanced?.job.error).not.toMatch(/shot_02/);
    expect(hole.motionInvokes.length).toBe(0);
  });

  it("module submit failure on driving-audio TTS fail-closes", async () => {
    const h = harness({ usage: USAGE_INFINITETALK, dialogue: "fail" });
    const mods = modulesFor(h, { usage: USAGE_INFINITETALK });
    const job = await startFilmJob(h.env, { ...START, motion_backend: "infinitetalk" }, mods);
    expect(job.phase).toBe("failed");
    expect(job.error).toMatch(/dialogue/);
    expect(h.motionInvokes.length).toBe(0);
  });

  it("speech-upscale runs once on the pre-clip path and is skipped after clips", async () => {
    const h = harness({ usage: USAGE_INFINITETALK, dialogue: "output", speech: true, finish: true, motionDone: true });
    const mods = modulesFor(h, { usage: USAGE_INFINITETALK, speech: true, finish: true });
    const started = await startFilmJob(h.env, { ...START, motion_backend: "infinitetalk" }, mods);
    expect(started.phase).toBe("pre_clip_dialogue");
    const afterTts = await advanceFilmJob(h.env, started.film_id, mods);
    expect(afterTts?.job.phase).toBe("pre_clip_speech");
    expect(h.speechInvokes).toBe(0);
    expect(h.motionInvokes.length).toBe(0);
    const afterSpeech = await advanceFilmJob(h.env, started.film_id, mods);
    expect(afterSpeech?.job.speech_done).toBe(true);
    const speechAtClips = h.speechInvokes;
    expect(speechAtClips).toBeGreaterThan(0);
    expect(["clips", "finish"]).toContain(afterSpeech?.job.phase);
    const afterClips = await advanceFilmJob(h.env, started.film_id, mods);
    expect(afterClips?.job.phase).toBe("finish");
    expect(h.speechInvokes).toBe(speechAtClips);
  });

  it("startFilmFromKeyframes takes the pre-clip branch and does not start clips yet", async () => {
    const h = harness({ usage: USAGE_INFINITETALK, dialogue: "pending" });
    const mods = modulesFor(h, { usage: USAGE_INFINITETALK });
    const job = await startFilmFromKeyframes(h.env, {
      project: "film",
      bundle_key: "bundles/film.tar.gz",
      scenes: SCENES,
      keyframes: [
        { shot_id: "shot_01", keyframe_key: "renders/film/keyframes/shot_01.png" },
        { shot_id: "shot_02", keyframe_key: "renders/film/keyframes/shot_02.png" },
      ],
      derive_mode: "finalized",
      motion_backend: "infinitetalk",
      dialogue_lines: START.dialogue_lines,
    }, mods);
    expect(job.phase).toBe("pre_clip_dialogue");
    expect(h.motionInvokes.length).toBe(0);
    expect(h.dialogueInvokes).toBe(1);
    expect(h.read(job.film_id).dialogue_lines?.map((l) => l.shot_id)).toEqual(["shot_01", "shot_02"]);
  });

  it("a board with zero lines never enters pre_clip_dialogue", async () => {
    const h = harness({ usage: USAGE_WAN, dialogue: "pending" });
    const mods = modulesFor(h, { usage: USAGE_WAN });
    const job = await startFilmJob(h.env, {
      ...START,
      motion_backend: "alibaba-wan",
      dialogue_lines: undefined,
    }, mods);
    expect(job.phase).toBe("clips");
    expect(h.dialogueInvokes).toBe(0);
    expect(h.motionInvokes.length).toBe(2);
  });

  it("POLLABLE_PHASES includes pre_clip_* and still omits post-clip dialogue", () => {
    expect([...POLLABLE_PHASES].sort()).toEqual(
      ["clips", "finish", "keyframe", "pre_clip_dialogue", "pre_clip_speech", "speech"].sort(),
    );
    expect(POLLABLE_PHASES.has("dialogue")).toBe(false);
  });
});
