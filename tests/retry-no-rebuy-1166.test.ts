import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startClipJob, type ClipShotInput } from "../src/render-orchestrator.js";
import { advanceFilmJob, startFilmFromKeyframes, type FilmJob } from "../src/film-orchestrator.js";
import { filmJobDocKey } from "../src/film-model.js";
import { provKey } from "../src/clip-provenance.js";
import { finishStepInputHash } from "../src/finish-hash.js";
import { mintSilenceWav } from "../src/wav-duration.js";
import { MODULE_API, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#1166: a retry must not buy again what it already owns. The count that matters is how many
// times a paid door was invoked, so every test here asserts on that number and not on job state.

afterEach(() => vi.restoreAllMocks());
const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); };

const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

/** An R2 whose etag follows the bytes, as the real one does, so changed content reads as changed. */
function memR2() {
  const store = new Map<string, Uint8Array>();
  const bytes = (v: unknown): Uint8Array => (typeof v === "string" ? new TextEncoder().encode(v) : (v as Uint8Array));
  const r2 = {
    put: async (k: string, v: unknown) => { store.set(k, bytes(v)); },
    get: async (k: string) => {
      const v = store.get(k);
      if (!v) return null;
      return {
        text: async () => new TextDecoder().decode(v),
        arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
      };
    },
    head: async (k: string) => {
      const v = store.get(k);
      return v ? { size: v.length, etag: createHash("md5").update(v).digest("hex") } : null;
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, uploaded: new Date(1000) })),
      truncated: false,
    }),
    delete: async (k: string) => { store.delete(k); },
  };
  return { store, r2 };
}

const motion = (name = "door"): RegisteredModule => ({
  name, version: "1", api: MODULE_API, hooks: ["motion.backend"], binding: `MODULE_${name.toUpperCase()}`, config_schema: {}, ui: { order: 1, section: "motion", locality: "cloud" },
} as unknown as RegisteredModule);

/** A door that writes its clip and counts every paid call. `fail` names shots it refuses. */
function clipHarness(names = ["door"]) {
  const { store, r2 } = memR2();
  const invokes: { door: string; shot: string }[] = [];
  const fail = new Set<string>();
  const env: Record<string, unknown> = {
    R2_RENDERS: r2,
    PRESIGNER: { presignGet: async (k: string) => `https://g/${k}`, presignPut: async (k: string) => `https://p/${k}` },
  };
  for (const n of names) {
    env[`MODULE_${n.toUpperCase()}`] = {
      fetch: async (_u: string, init?: RequestInit) => {
        const shot = (JSON.parse(String(init?.body)) as { input: { shot_id: string } }).input.shot_id;
        invokes.push({ door: n, shot });
        if (fail.has(shot)) return json({ ok: false, error: "refused", reason: "permanent" });
        const clip_key = `renders/p/clips/${shot}_${n}.mp4`;
        store.set(clip_key, new TextEncoder().encode(`${n}:${shot}:${invokes.length}`));
        return json({ ok: true, output: { shot_id: shot, clip_key, fps: 24, frames: 1 } });
      },
    };
  }
  return { store, env: env as unknown as Env, invokes, fail, mods: names.map(motion) };
}

const shot = (id: string, over: Partial<ClipShotInput> = {}): ClipShotInput => ({
  shot_id: id, keyframe_url: "https://g/k", keyframe_key: `renders/p/keyframes/${id}.png`, prompt: `prompt ${id}`, seconds: 5, ...over,
} as ClipShotInput);
const run = (h: ReturnType<typeof clipHarness>, shots: ClipShotInput[], over: Record<string, unknown> = {}) =>
  startClipJob(h.env, { project: "p", shots, motion_backend: "door", reuse_proven: true, ...over }, h.mods);
const seedKeyframes = (h: ReturnType<typeof clipHarness>, ...ids: string[]) => {
  for (const id of ids) h.store.set(`renders/p/keyframes/${id}.png`, new TextEncoder().encode(`kf ${id}`));
};

describe("a retry after one failed shot", () => {
  it("invokes the door for that shot alone", async () => {
    quiet();
    const h = clipHarness();
    seedKeyframes(h, "s1", "s2", "s3");
    h.fail.add("s2");
    await run(h, [shot("s1"), shot("s2"), shot("s3")], { reuse_proven: false });
    expect(h.invokes).toHaveLength(3);
    h.invokes.length = 0;
    h.fail.clear();
    const job = await run(h, [shot("s1"), shot("s2"), shot("s3")]);
    expect(h.invokes.map((i) => i.shot)).toEqual(["s2"]);
    expect(job.shots.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(job.shots.map((s) => !!s.reused)).toEqual([true, false, true]);
  });

  it("keeps the same clip and archives nothing", async () => {
    quiet();
    const h = clipHarness();
    seedKeyframes(h, "s1");
    await run(h, [shot("s1")]);
    const before = h.store.get("renders/p/clips/s1_door.mp4");
    const job = await run(h, [shot("s1")]);
    expect(job.shots[0].clip_key).toBe("renders/p/clips/s1_door.mp4");
    expect(h.store.get("renders/p/clips/s1_door.mp4")).toBe(before);
    expect([...h.store.keys()].filter((k) => k.includes("_take"))).toEqual([]);
  });

  it("CONTROL: with reuse off, a resubmit is a new take and pays again", async () => {
    quiet();
    const h = clipHarness();
    seedKeyframes(h, "s1");
    await run(h, [shot("s1")], { reuse_proven: false });
    await run(h, [shot("s1")], { reuse_proven: false });
    expect(h.invokes).toHaveLength(2);
  });
});

describe("a retake of one shot", () => {
  it("buys that shot's clip alone, though its inputs are proven the same", async () => {
    quiet();
    const h = clipHarness();
    seedKeyframes(h, "s1", "s2", "s3");
    await run(h, [shot("s1"), shot("s2"), shot("s3")]);
    const before = h.store.get("renders/p/clips/s2_door.mp4");
    h.invokes.length = 0;
    const job = await run(h, [shot("s1"), shot("s2"), shot("s3")], { retake_shots: ["s2"] });
    expect(h.invokes.map((i) => i.shot)).toEqual(["s2"]);
    expect(job.shots.map((s) => !!s.reused)).toEqual([true, false, true]);
    expect(h.store.get("renders/p/clips/s2_door.mp4")).not.toEqual(before);
  });

  it("names no other shot by accident: an unknown id buys nothing", async () => {
    quiet();
    const h = clipHarness();
    seedKeyframes(h, "s1");
    await run(h, [shot("s1")]);
    h.invokes.length = 0;
    await run(h, [shot("s1")], { retake_shots: ["nope"] });
    expect(h.invokes).toEqual([]);
  });
});

describe("a clip is reused only on proof", () => {
  const twice = async (h: ReturnType<typeof clipHarness>, first: ClipShotInput, second: ClipShotInput) => {
    const made = await run(h, [first]);
    expect(made.shots[0].status, "DENOMINATOR: the first run made a clip").toBe("done");
    h.invokes.length = 0;
    await run(h, [second]);
    return h.invokes.length;
  };
  const withFiles = () => {
    const h = clipHarness();
    seedKeyframes(h, "s1", "s2");
    h.store.set("renders/p/dialogue/s1.wav", new TextEncoder().encode("line a"));
    h.store.set("renders/p/voice.wav", new TextEncoder().encode("voice a"));
    return h;
  };
  it.each([
    ["the prompt", { prompt: "another" }],
    ["the seconds", { seconds: 6 }],
  ])("%s changed: pays", async (_n, over) => {
    quiet();
    expect(await twice(withFiles(), shot("s1"), shot("s1", over as Partial<ClipShotInput>))).toBe(1);
  });

  it("the keyframe's bytes changed: pays", async () => {
    quiet();
    const h = withFiles();
    await run(h, [shot("s1")]);
    h.invokes.length = 0;
    h.store.set("renders/p/keyframes/s1.png", new TextEncoder().encode("kf redrawn"));
    await run(h, [shot("s1")]);
    expect(h.invokes).toHaveLength(1);
  });

  it("the driving audio's bytes changed: pays, because the mouth follows it", async () => {
    quiet();
    const h = withFiles();
    const s = shot("s1", { audio_key: "renders/p/dialogue/s1.wav" });
    await run(h, [s]);
    h.invokes.length = 0;
    await run(h, [s]);
    expect(h.invokes).toHaveLength(0);
    h.store.set("renders/p/dialogue/s1.wav", new TextEncoder().encode("line b"));
    await run(h, [s]);
    expect(h.invokes).toHaveLength(1);
  });

  it("the end frame's bytes changed: pays", async () => {
    quiet();
    const h = withFiles();
    const s = shot("s1", { last_keyframe_key: "renders/p/keyframes/s2.png" });
    await run(h, [s]);
    h.invokes.length = 0;
    h.store.set("renders/p/keyframes/s2.png", new TextEncoder().encode("kf 2 redrawn"));
    await run(h, [s]);
    expect(h.invokes).toHaveLength(1);
  });

  it("the voice sample's bytes changed: pays", async () => {
    quiet();
    const h = withFiles();
    const s = shot("s1", { voice_ref_key: "renders/p/voice.wav" });
    await run(h, [s]);
    h.invokes.length = 0;
    h.store.set("renders/p/voice.wav", new TextEncoder().encode("voice b"));
    await run(h, [s]);
    expect(h.invokes).toHaveLength(1);
  });

  it("the config changed: pays", async () => {
    quiet();
    const h = clipHarness();
    h.mods[0] = { ...h.mods[0], config_schema: { q: { type: "int", default: 1 } } } as unknown as RegisteredModule;
    seedKeyframes(h, "s1");
    await run(h, [shot("s1")], { config: { q: 1 } });
    h.invokes.length = 0;
    await run(h, [shot("s1")], { config: { q: 2 } });
    expect(h.invokes).toHaveLength(1);
  });

  it("another door's clip is never taken", async () => {
    quiet();
    const h = clipHarness(["door", "other"]);
    seedKeyframes(h, "s1");
    await run(h, [shot("s1")], { motion_backend: "other" });
    h.invokes.length = 0;
    await run(h, [shot("s1")], { motion_backend: "door" });
    expect(h.invokes).toEqual([{ door: "door", shot: "s1" }]);
  });

  it("a clip with no sidecar is not proof", async () => {
    quiet();
    const h = withFiles();
    await run(h, [shot("s1")]);
    h.store.delete(provKey("renders/p/clips/s1_door.mp4"));
    h.invokes.length = 0;
    await run(h, [shot("s1")]);
    expect(h.invokes).toHaveLength(1);
  });

  it("an archived take is not reused", async () => {
    quiet();
    const h = withFiles();
    await run(h, [shot("s1")], { reuse_proven: false });
    await run(h, [shot("s1")], { reuse_proven: false });
    const take = [...h.store.keys()].find((k) => k.includes("_take") && !k.endsWith(".prov"));
    expect(take).toBeTruthy();
    h.store.delete("renders/p/clips/s1_door.mp4");
    h.invokes.length = 0;
    const job = await run(h, [shot("s1")]);
    expect(h.invokes).toHaveLength(1);
    expect(job.shots[0].clip_key).toBe("renders/p/clips/s1_door.mp4");
  });
});

describe("through a whole film", () => {
  const talking = {
    name: "talk", version: "1", api: MODULE_API, hooks: ["motion.backend"], binding: "MODULE_TALK", config_schema: {},
    ui: { order: 1, section: "motion", locality: "cloud" },
    usage: { native_audio: false, voice: "cast_tts", scatter_native_audio: false, driving_audio: true, min_seconds: 2, max_seconds: 15 },
  } as unknown as RegisteredModule;
  const dialogue = { name: "voices", version: "1", api: MODULE_API, hooks: ["dialogue"], binding: "MODULE_VOICES", config_schema: {}, ui: { order: 5, section: "dialogue" } } as unknown as RegisteredModule;
  const LINES = [{ shot_id: "shot_01", text: "first", voice_id: "a" }, { shot_id: "shot_02", text: "second", voice_id: "b" }];
  const SCENES = [{ shot_id: "shot_01", prompt: "one", seconds: 3 }, { shot_id: "shot_02", prompt: "two", seconds: 3 }];

  function filmHarness() {
    const { store, r2 } = memR2();
    const lines: string[][] = [];
    const clips: string[] = [];
    let take = 0;
    const env = {
      R2_RENDERS: r2,
      PRESIGNER: { presignGet: async (k: string) => `https://g/${k}`, presignPut: async (k: string) => `https://p/${k}` },
      MODULE_VOICES: {
        fetch: async (_u: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { input: { project: string; lines: { shot_id: string }[] } };
          const ids = body.input.lines.map((l) => l.shot_id);
          lines.push(ids);
          take += 1;
          const audio = [];
          for (const id of ids) {
            const key = `renders/${body.input.project}/dialogue/${id}.wav`;
            // A provider need not repeat itself: each synth is different bytes.
            store.set(key, mintSilenceWav(4 + take * 0.1));
            audio.push({ shot_id: id, audio_key: key, voice_id: "a", duration_s: 4 });
          }
          return json({ ok: true, output: { project: body.input.project, applied: ["voices"], audio } });
        },
      },
      MODULE_TALK: {
        fetch: async (_u: string, init?: RequestInit) => {
          const id = (JSON.parse(String(init?.body)) as { input: { shot_id: string } }).input.shot_id;
          clips.push(id);
          const clip_key = `renders/p/clips/${id}_talk.mp4`;
          store.set(clip_key, new TextEncoder().encode(`clip ${id} ${clips.length}`));
          return json({ ok: true, output: { shot_id: id, clip_key, fps: 25, frames: 1 } });
        },
      },
    } as unknown as Env;
    store.set("renders/p/keyframes/shot_01.png", new TextEncoder().encode("kf1"));
    store.set("renders/p/keyframes/shot_02.png", new TextEncoder().encode("kf2"));
    return { store, env, lines, clips };
  }
  const submit = async (h: ReturnType<typeof filmHarness>, reuse: boolean, dialogue_lines = LINES, retake_shots?: string[]) => {
    const job = await startFilmFromKeyframes(h.env, {
      project: "p", bundle_key: "bundles/p.tar.gz", scenes: SCENES,
      keyframes: SCENES.map((s) => ({ shot_id: s.shot_id, keyframe_key: `renders/p/keyframes/${s.shot_id}.png`, prompt: s.prompt, seconds: s.seconds })),
      motion_backend: "talk", dialogue_lines, reuse_finished: reuse, retake_shots, idempotency_key: `k-${Math.random()}`,
    } as never, [talking, dialogue]);
    // A driving door buys its lines, then its clips, across ticks.
    for (let i = 0; i < 4; i++) await advanceFilmJob(h.env, job.film_id, [talking, dialogue]);
    return job;
  };

  it("a second run buys no lines and no clips", async () => {
    quiet();
    const h = filmHarness();
    await submit(h, true);
    expect(h.lines).toEqual([["shot_01", "shot_02"]]);
    expect(h.clips.sort()).toEqual(["shot_01", "shot_02"]);
    h.lines.length = 0;
    h.clips.length = 0;
    await submit(h, true);
    expect(h.lines).toEqual([]);
    expect(h.clips).toEqual([]);
  });

  it("one changed line buys one line and one clip", async () => {
    quiet();
    const h = filmHarness();
    await submit(h, true);
    h.lines.length = 0;
    h.clips.length = 0;
    await submit(h, true, [LINES[0], { ...LINES[1], text: "changed" }]);
    expect(h.lines).toEqual([["shot_02"]]);
    expect(h.clips).toEqual(["shot_02"]);
  });

  it("a retake buys one clip and no lines, and the kept line drives it", async () => {
    quiet();
    const h = filmHarness();
    await submit(h, true);
    const wav = h.store.get("renders/p/dialogue/shot_02.wav");
    h.lines.length = 0;
    h.clips.length = 0;
    await submit(h, true, LINES, ["shot_02"]);
    expect(h.lines).toEqual([]);
    expect(h.clips).toEqual(["shot_02"]);
    expect(h.store.get("renders/p/dialogue/shot_02.wav")).toBe(wav);
  });

  it("a re-run from keyframes keeps the frame, the titles and the cast on the job", async () => {
    quiet();
    const h = filmHarness();
    const job = await startFilmFromKeyframes(h.env, {
      project: "p", bundle_key: "bundles/p.tar.gz", scenes: SCENES,
      keyframes: SCENES.map((s) => ({ shot_id: s.shot_id, keyframe_key: `renders/p/keyframes/${s.shot_id}.png` })),
      motion_backend: "talk", derive_mode: "finalized", idempotency_key: `k-${Math.random()}`,
      delivery_width: 832, delivery_height: 464, delivery_fps: 24,
      film_titles: { title: { text: "T" } }, cast_loras: { A: 7 },
    } as never, [talking, dialogue]);
    expect([job.delivery_width, job.delivery_height, job.delivery_fps]).toEqual([832, 464, 24]);
    expect(job.film_titles).toEqual({ title: { text: "T" } });
    expect(job.cast_loras).toEqual({ A: 7 });
  });

  it("a retake with a new line buys that line and that clip alone", async () => {
    quiet();
    const h = filmHarness();
    await submit(h, true);
    h.lines.length = 0;
    h.clips.length = 0;
    await submit(h, true, [LINES[0], { ...LINES[1], text: "changed" }], ["shot_02"]);
    expect(h.lines).toEqual([["shot_02"]]);
    expect(h.clips).toEqual(["shot_02"]);
  });

  it("a changed voice buys that line again", async () => {
    quiet();
    const h = filmHarness();
    await submit(h, true);
    h.lines.length = 0;
    await submit(h, true, [{ ...LINES[0], voice_id: "z" }, LINES[1]]);
    expect(h.lines).toEqual([["shot_01"]]);
  });

  it("a silent door started from keyframes also pays nothing on the second run", async () => {
    quiet();
    const h = filmHarness();
    const silent = { ...talking, usage: { native_audio: false, voice: "cast_tts", scatter_native_audio: false, min_seconds: 2, max_seconds: 15 } } as unknown as RegisteredModule;
    const go = () => startFilmFromKeyframes(h.env, {
      project: "p", bundle_key: "bundles/p.tar.gz", scenes: SCENES,
      keyframes: SCENES.map((s) => ({ shot_id: s.shot_id, keyframe_key: `renders/p/keyframes/${s.shot_id}.png`, prompt: s.prompt, seconds: s.seconds })),
      motion_backend: "talk", reuse_finished: true, idempotency_key: `k-${Math.random()}`,
    } as never, [silent]);
    await go();
    expect(h.clips.sort()).toEqual(["shot_01", "shot_02"]);
    h.clips.length = 0;
    await go();
    expect(h.clips).toEqual([]);
  });

  it("CONTROL: with reuse off, the same film pays for everything again", async () => {
    quiet();
    const h = filmHarness();
    await submit(h, false);
    h.lines.length = 0;
    h.clips.length = 0;
    await submit(h, false);
    expect(h.lines).toEqual([["shot_01", "shot_02"]]);
    expect(h.clips.sort()).toEqual(["shot_01", "shot_02"]);
  });
});

describe("a finish step", () => {
  const UP = {
    name: "up", version: "1", api: MODULE_API, hooks: ["finish"], binding: "MODULE_UP", config_schema: {}, ui: { order: 20, section: "finish" },
    finish_artifacts: { output_key: { kind: "append_suffix", suffix: "_up" }, applied: [{ tag: "upscale" }] },
  } as unknown as RegisteredModule;
  const CLIP = "renders/p/clips/s1_door.mp4";
  const OUT = "renders/p/clips/s1_door_up.mp4";

  async function runFinish(reuse: boolean, stamped: "match" | "stale" | "none") {
    quiet();
    const { store, r2 } = memR2();
    let invoked = 0;
    store.set(CLIP, new TextEncoder().encode("clip"));
    store.set(OUT, new TextEncoder().encode("upscaled"));
    const etag = createHash("md5").update("clip").digest("hex");
    if (stamped !== "none") store.set(`${OUT}.hash`, new TextEncoder().encode(await finishStepInputHash(stamped === "match" ? etag : "other", null, {})));
    const job = {
      film_id: "film-1", project: "p", phase: "finish", created_at: 1, phase_started_at: Date.now(), last_progress_at: Date.now(), scenes: [], bundle_key: "b",
      reuse_finished: reuse || undefined,
      finish_shots: [{ shot_id: "s1", clip_key: CLIP, chain: ["MODULE_UP"], configs: [{}], idx: 0, status: "pending", applied: [] }],
    } as unknown as FilmJob;
    store.set(filmJobDocKey("film-1"), new TextEncoder().encode(JSON.stringify(job)));
    const env = {
      R2_RENDERS: r2, DB: undefined,
      PRESIGNER: { presignGet: async (k: string) => `https://g/${k}`, presignPut: async (k: string) => `https://p/${k}` },
      MODULE_UP: { fetch: async () => { invoked += 1; return json({ ok: true, pending: true, poll: "t" }); } },
    } as unknown as Env;
    await advanceFilmJob(env, "film-1", [UP]);
    return invoked;
  }
  it("that already ran on these inputs is not paid for again", async () => { expect(await runFinish(true, "match")).toBe(0); });
  it("whose clip changed runs again", async () => { expect(await runFinish(true, "stale")).toBe(1); });
  it("with no proof runs again", async () => { expect(await runFinish(true, "none")).toBe(1); });
  it("CONTROL: with reuse off, runs again", async () => { expect(await runFinish(false, "match")).toBe(1); });
});
