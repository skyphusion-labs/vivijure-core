import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceFilmJob, filmJobDocKey, resolveFilmFrame, runFilmFinish, startFilmFromKeyframes, startFilmJob, type FilmJob } from "../src/film-orchestrator.js";
import { clipJobDocKey, predictDeliveryFps, resolveDeliveryFps, summarizeFinish } from "../src/film-model.js";
import { parseMoov } from "../src/clip-validate.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { RegisteredModule } from "../src/modules/types.js";

// vivijure-cf#1144, measured on film-f70f2700: shot_01_finished.mp4 is 48 fps with 281 frames, and the
// final film was 24 fps with nothing to say so. A film now ships at the rate its finish chain produced.

afterEach(() => vi.restoreAllMocks());

/** A real box tree, so the production parser reads it. `mediaSeconds` adds an mdhd; `movieSeconds` is mvhd. */
function mp4(frames: number, movieSeconds = 6, mediaSeconds?: number): Uint8Array {
  const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const timed = (seconds: number, length: number) => {
    const b = new Uint8Array(length);
    new DataView(b.buffer).setUint32(12, 1000);
    new DataView(b.buffer).setUint32(16, seconds * 1000);
    return b;
  };
  const tkhd = new Uint8Array(84);
  new DataView(tkhd.buffer).setUint32(76, 1344 * 65536);
  new DataView(tkhd.buffer).setUint32(80, 768 * 65536);
  const hdlr = new Uint8Array(24);
  hdlr.set([0x76, 0x69, 0x64, 0x65], 8);
  const stsz = new Uint8Array(12);
  new DataView(stsz.buffer).setUint32(4, 1000);
  new DataView(stsz.buffer).setUint32(8, frames);
  const mdhd = mediaSeconds === undefined ? [] : [box("mdhd", timed(mediaSeconds, 24))];
  const mdia = box("mdia", ...mdhd, box("hdlr", hdlr), box("minf", box("stbl", box("stsz", stsz))));
  const moov = box("moov", box("mvhd", timed(movieSeconds, 100)), box("trak", box("tkhd", tkhd), mdia));
  const ftyp = box("ftyp", new Uint8Array(8));
  const pad = box("free", new Uint8Array(4096));
  const out = new Uint8Array(ftyp.length + moov.length + pad.length);
  out.set(ftyp, 0); out.set(moov, ftyp.length); out.set(pad, ftyp.length + moov.length);
  return out;
}

const KEY = "renders/p/clips/s1_finished.mp4";
const CLIP_DOC = clipJobDocKey("c");
const clipDoc = (seconds = 6) => ({ job_id: "c", shots: [{ shot_id: "s1", status: "done", delivered_width: 1344, delivered_height: 768, delivered_frames: seconds * 24, delivered_fps: 24 }] });

function env(clip: Uint8Array, docs: Record<string, unknown> = {}, bindings: Record<string, unknown> = {}) {
  const text: Record<string, string> = { [CLIP_DOC]: JSON.stringify(clipDoc()) };
  for (const [k, v] of Object.entries(docs)) text[k] = JSON.stringify(v);
  return {
    R2_RENDERS: {
      head: async (k: string) => (k === KEY ? { size: clip.length } : k in text ? { size: 1 } : null),
      get: async (k: string, opts?: { range?: { offset: number; length: number } }) => {
        if (k === KEY) {
          const off = opts?.range?.offset ?? 0;
          const slice = clip.slice(off, off + (opts?.range?.length ?? clip.length));
          return { arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
        }
        return k in text ? { text: async () => text[k] } : null;
      },
      put: async (k: string, b: string) => { text[k] = b; },
      delete: async () => {},
      list: async () => ({ objects: [] }),
    },
    PRESIGNER: { presignGet: async (k: string) => `https://g/${k}`, presignPut: async (k: string) => `https://p/${k}` },
    ...bindings,
  } as unknown as Env;
}

const job = (over: Partial<FilmJob> = {}, applied = ["interpolate:2x"]): FilmJob => ({
  film_id: "film-1", project: "p", phase: "assemble", created_at: 1, scenes: [], bundle_key: "b", clip_job_id: "c",
  finish_shots: [{ shot_id: "s1", clip_key: KEY, chain: ["MODULE_R"], configs: [{}], idx: 1, status: "done", applied }],
  ...over,
}) as unknown as FilmJob;

describe("the rate a film ships at", () => {
  it("is the rate interpolation produced (the measured case)", async () => {
    const j = job();
    await resolveFilmFrame(env(mp4(288)), j);
    expect(j.assemble_fps).toBe(48);
    expect(summarizeFinish(j.finish_shots!).degraded).toBe(0);
  });

  it("reads an adopted interpolation the same as a run one", async () => {
    const j = job({ finish_shots: [{ shot_id: "s1", clip_key: KEY, chain: ["MODULE_R"], configs: [{}], idx: 1, status: "done", applied: [], adopted: ["interpolate:2x"] }] as never });
    await resolveFilmFrame(env(mp4(288)), j);
    expect(j.assemble_fps).toBe(48);
  });

  it("CONTROL: no interpolation stays at 24, even when the door delivered more", async () => {
    const j = job({}, ["upscale:2x"]);
    await resolveFilmFrame(env(mp4(180)), j);
    expect(j.assemble_fps).toBeUndefined();
    expect(resolveDeliveryFps(j)).toBe(24);
    expect(summarizeFinish(j.finish_shots!).reasons).toContain("finished clip is 30 fps, delivered at 24 fps");
  });

  it("interpolation that ends below 24 stays at 24", async () => {
    const j = job();
    await resolveFilmFrame(env(mp4(96)), j);
    expect(j.assemble_fps).toBeUndefined();
  });

  it("takes the picture's length, not an audio track that outlasts it", async () => {
    const j = job();
    await resolveFilmFrame(env(mp4(288, 7.5, 6)), j);
    expect(j.assemble_fps).toBe(48);
  });

  it("the parser keeps the media length of a video track only", () => {
    const whole = mp4(288, 7.5, 6);
    const moov = whole.slice(16 + 8); // past ftyp and the moov header
    expect(parseMoov(moov).videoDurationS).toBe(6);
    expect(parseMoov(mp4(288).slice(16 + 8)).videoDurationS ?? null).toBeNull();
  });

  it("an audio track's media length is never read as the picture's", () => {
    const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
      const size = 8 + parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(size);
      new DataView(out.buffer).setUint32(0, size);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      let o = 8;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    };
    const mdhd = new Uint8Array(24);
    new DataView(mdhd.buffer).setUint32(12, 1000);
    new DataView(mdhd.buffer).setUint32(16, 7500);
    const hdlr = new Uint8Array(24);
    hdlr.set([0x73, 0x6f, 0x75, 0x6e], 8); // soun
    const audioOnly = box("trak", box("mdia", box("mdhd", mdhd), box("hdlr", hdlr)));
    expect(parseMoov(audioOnly).videoDurationS ?? null).toBeNull();
  });
});

describe("an explicit delivery_fps", () => {
  it("wins, and a drop is reported", async () => {
    const j = job({ delivery_fps: 24 });
    await resolveFilmFrame(env(mp4(288)), j);
    expect(resolveDeliveryFps(j)).toBe(24);
    const s = summarizeFinish(j.finish_shots!);
    expect(s.degraded).toBe(1);
    expect(s.reasons).toContain("finished clip is 48 fps, delivered at 24 fps");
  });

  it("at or above the clip reports nothing", async () => {
    const j = job({ delivery_fps: 60 });
    await resolveFilmFrame(env(mp4(288)), j);
    expect(resolveDeliveryFps(j)).toBe(60);
    expect(summarizeFinish(j.finish_shots!).degraded).toBe(0);
  });

  it("does not report a clip that rounds to the rate", async () => {
    const j = job({ delivery_fps: 24 });
    await resolveFilmFrame(env(mp4(149)), j);
    expect(summarizeFinish(j.finish_shots!).degraded).toBe(0);
  });

  it("wins the prediction too", () => {
    const chain = [[{ binding: "MODULE_FINISH_RIFE", config: { interpolation_factor: 4 } }]];
    expect(predictDeliveryFps({}, chain)).toBe(96);
    expect(predictDeliveryFps({ delivery_fps: 30 }, chain)).toBe(30);
  });
});

describe("predicting the rate", () => {
  const rife = (config: Record<string, unknown>) => [[{ binding: "MODULE_FINISH_RIFE", config }]];
  it.each([
    [{}, 48],
    [{ interpolation_factor: 2 }, 48],
    [{ interpolation_factor: 4 }, 96],
    [{ interpolation_factor: 1 }, 24],
    [{ interpolate: false, interpolation_factor: 4 }, 24],
  ])("%o gives %i", (config, want) => {
    expect(predictDeliveryFps({}, rife(config))).toBe(want);
  });
  it("a step that does not interpolate adds nothing, and the busiest shot decides", () => {
    expect(predictDeliveryFps({}, [[{ binding: "MODULE_FINISH_UPSCALE", config: { interpolation_factor: 4 } }]])).toBe(24);
    expect(predictDeliveryFps({}, [...rife({ interpolation_factor: 2 }), []])).toBe(48);
    expect(predictDeliveryFps({}, [])).toBe(24);
  });
});

describe("the assemble door", () => {
  const assemble = async (clip: Uint8Array, over: Partial<FilmJob>, seconds = 6, applied?: string[]) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bodies: { fps?: number }[] = [];
    const door = {
      fetch: async (url: string, init: RequestInit = {}) => {
        if (new URL(url).pathname === "/async/finish") {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({ ok: true, jobId: "j" }, { status: 202 });
        }
        return Response.json({ status: "running" });
      },
    };
    const j = job({ scenes: [{ shot_id: "s1", prompt: "p", seconds }] as never, phase_started_at: Date.now(), last_progress_at: Date.now(), ...over }, applied);
    const e = env(clip, { [CLIP_DOC]: clipDoc(seconds), [filmJobDocKey("film-1")]: j }, {
      DB: undefined, MEDIA_FINISH_TOKEN: "t", VIDEO_FINISH_URL: "http://vf", MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door },
    });
    const r = await advanceFilmJob(e, "film-1", []);
    return { bodies, job: r!.job };
  };

  it("is asked for the produced rate", async () => {
    const { bodies, job: after } = await assemble(mp4(288), {});
    expect(bodies[0].fps).toBe(48);
    expect(after.assemble_fps).toBe(48);
  });

  it("CONTROL: is asked for 24 with no interpolation", async () => {
    const { bodies } = await assemble(mp4(144), {}, 6, ["upscale:2x"]);
    expect(bodies[0].fps).toBe(24);
  });

  it("is asked for an explicit rate", async () => {
    const { bodies } = await assemble(mp4(288), { delivery_fps: 30 });
    expect(bodies[0].fps).toBe(30);
  });

  // 5400s at 1344x768 is 4.2 GB at 24 fps and 8.4 GB at 48, against a 6.85 GB ceiling.
  it("its budget prices the produced rate", async () => {
    const { bodies, job: after } = await assemble(mp4(288), {}, 5400);
    expect(bodies).toHaveLength(0);
    expect(after.error).toMatch(/@48 predict/);
    expect(after.error).toMatch(/interpolation factor/);
  });

  it("CONTROL: the same film at 24 is admitted", async () => {
    const { bodies } = await assemble(mp4(144), {}, 5400, ["upscale:2x"]);
    expect(bodies).toHaveLength(1);
  });
});

describe("the film.finish seed", () => {
  const TITLES = { name: "film-titles", version: "0.1.0", api: "vivijure-module/2", hooks: ["film.finish"], ui: { section: "finish", order: 10 }, binding: "MODULE_FILM_TITLES" } as unknown as RegisteredModule;
  const seedFps = async (over: Record<string, unknown>) => {
    const seen: Record<string, unknown>[] = [];
    const e = env(new Uint8Array(0), {}, {
      MODULE_FILM_TITLES: {
        fetch: async (_u: unknown, init: { body?: string }) => {
          const body = JSON.parse(init?.body ?? "{}") as { input?: Record<string, unknown> };
          if (body.input) seen.push(body.input);
          return Response.json({ ok: true, output: { film_key: "f.mp4", applied: [] } });
        },
      },
    });
    await runFilmFinish(e, { film_key: "f.mp4", scenes: [], bundle_key: "b", project: "p", job_id: "j", ...over }, [TITLES]);
    return seen[0].fps;
  };
  it("carries the rate assemble built", async () => { expect(await seedFps({ assemble_fps: 48 })).toBe(48); });
  it("an explicit rate wins", async () => { expect(await seedFps({ assemble_fps: 48, delivery_fps: 30 })).toBe(30); });
  it("CONTROL: 24 with neither", async () => { expect(await seedFps({})).toBe(24); });
  it("reaches the seed from the film doc, on the real advance", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const seen: Record<string, unknown>[] = [];
    const j = job({
      phase: "mux", phase_started_at: Date.now(), last_progress_at: Date.now(), assemble_fps: 48,
      film_key: "renders/p/film.mp4", film_finish_base_key: "renders/p/film.mp4", film_finish_resume: true,
      film_titles: { title: { text: "T" } },
    });
    const e = env(new Uint8Array(0), { [filmJobDocKey("film-1")]: j }, {
      DB: undefined,
      MODULE_FILM_TITLES: {
        fetch: async (_u: unknown, init: { body?: string }) => {
          const body = JSON.parse(init?.body ?? "{}") as { input?: Record<string, unknown> };
          if (body.input) seen.push(body.input);
          return Response.json({ ok: true, pending: true, poll: "t" });
        },
      },
    });
    await advanceFilmJob(e, "film-1", [TITLES]);
    expect(seen.length, "DENOMINATOR: the titles module was invoked").toBeGreaterThan(0);
    expect(seen[0].fps).toBe(48);
  });
});

describe("the budget, before the film costs anything", () => {
  const KF = { name: "keyframe", version: "0.1.0", api: "vivijure-module/2", binding: "MODULE_KEYFRAME", hooks: ["keyframe"], config_schema: {}, ui: { section: "keyframe", order: 10 } } as unknown as RegisteredModule;
  const MOTION = { name: "seedance", version: "0.1.0", api: "vivijure-module/2", binding: "MODULE_SEEDANCE", hooks: ["motion.backend"], config_schema: {}, ui: { section: "motion", order: 6, locality: "cloud" } } as unknown as RegisteredModule;
  const RIFE = {
    name: "finish-rife", version: "0.1.0", api: "vivijure-module/2", binding: "MODULE_FINISH_RIFE", hooks: ["finish"],
    config_schema: { interpolate: { type: "bool", default: true }, interpolation_factor: { type: "int", default: 2, min: 1, max: 8 } },
    ui: { section: "finish", order: 10 },
  } as unknown as RegisteredModule;

  const harness = () => {
    const calls = { keyframe: 0, motion: 0 };
    const reply = (k: keyof typeof calls, body: unknown) => ({ fetch: async () => { calls[k] += 1; return Response.json(body); } });
    const objects = new Map<string, string>();
    const e = {
      MODULE_KEYFRAME: reply("keyframe", { ok: true, pending: true, poll: "k" }),
      MODULE_SEEDANCE: reply("motion", { ok: true, pending: true, poll: "c" }),
      MODULE_FINISH_RIFE: { fetch: async () => Response.json({ ok: true }) },
      PRESIGNER: { presignGet: async (k: string) => `https://g/${k}`, presignPut: async (k: string) => `https://p/${k}` },
      R2_RENDERS: {
        put: async (k: string, v: string) => { objects.set(k, v); },
        get: async (k: string) => (objects.has(k) ? { text: async () => objects.get(k) } : null),
        head: async () => null,
      },
    } as unknown as Env;
    return { e, calls };
  };
  // 1920x1080 fits about 4894s at 24 fps and 2447s at 48. 3000s sits between them.
  const SCENES = [{ shot_id: "shot_01", prompt: "slow push", seconds: 3000 }];
  const ARGS = { project: "film", bundle_key: "bundles/film.tar.gz", scenes: SCENES, motion_backend: "seedance" };
  const KF_ARGS = { ...ARGS, keyframes: [{ shot_id: "shot_01", keyframe_key: "keyframes/shot_01.png", prompt: "slow push", seconds: 3000 }], derive_mode: "finalized" as const };
  const mods = [KF, MOTION, RIFE];
  const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); };

  it("startFilmJob refuses at 48 before a keyframe is bought", async () => {
    quiet();
    const h = harness();
    const j = await startFilmJob(h.e, ARGS as never, mods);
    expect(j.phase).toBe("failed");
    expect(j.error).toMatch(/@48 predict/);
    expect(h.calls.keyframe).toBe(0);
  });

  it("CONTROL: the same film with interpolation off starts", async () => {
    quiet();
    const h = harness();
    const j = await startFilmJob(h.e, { ...ARGS, finish_config: { "finish-rife": { interpolation_factor: 1 } } } as never, mods);
    expect(j.phase).not.toBe("failed");
    expect(h.calls.keyframe).toBe(1);
  });

  it("CONTROL: the same film with no finish module named starts", async () => {
    quiet();
    const h = harness();
    const j = await startFilmJob(h.e, { ...ARGS, finish_select: { mode: "named", modules: [] } } as never, mods);
    expect(j.phase).not.toBe("failed");
    expect(h.calls.keyframe).toBe(1);
  });

  it.each([["keyframes_only"], ["clips_only"]])("a %s film never assembles, so it is not priced", async (flag) => {
    quiet();
    const h = harness();
    const j = await startFilmJob(h.e, { ...ARGS, [flag]: true } as never, mods);
    expect(j.phase).not.toBe("failed");
    expect(h.calls.keyframe).toBe(1);
  });

  it("startFilmFromKeyframes refuses before a clip is bought", async () => {
    quiet();
    const h = harness();
    const j = await startFilmFromKeyframes(h.e, KF_ARGS as never, mods);
    expect(j.phase).toBe("failed");
    expect(j.error).toMatch(/@48 predict/);
    expect(h.calls.motion).toBe(0);
  });

  it("CONTROL: from keyframes with interpolation off starts its clips", async () => {
    quiet();
    const h = harness();
    const j = await startFilmFromKeyframes(h.e, { ...KF_ARGS, finish_config: { "finish-rife": { interpolate: false } } } as never, mods);
    expect(j.error).toBeUndefined();
    expect(j.phase).toBe("clips");
    expect(h.calls.motion).toBe(1);
  });
});

describe("the finish step gate", () => {
  const U = { name: "finish-upscale", version: "1", api: "vivijure-module/2", hooks: ["finish"], ui: { section: "finish", order: 20 }, binding: "MODULE_U", finish_scales_frame: true } as unknown as RegisteredModule;
  const run = async (chain: string[], configs: Record<string, unknown>[]) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    let invoked = 0;
    const door = { fetch: async () => { invoked += 1; return Response.json({ ok: true, pending: true, poll: "t" }); } };
    const j = job({
      phase: "finish", phase_started_at: Date.now(), last_progress_at: Date.now(),
      finish_shots: [{ shot_id: "s1", clip_key: KEY, chain, configs, idx: chain.length - 1, status: "pending", applied: [] }] as never,
    });
    const e = env(new Uint8Array(0), { [CLIP_DOC]: clipDoc(1500), [filmJobDocKey("film-1")]: j }, { DB: undefined, MODULE_U: door });
    await advanceFilmJob(e, "film-1", [U]);
    return invoked;
  };
  // A 2x upscale of 1344x768 at 1500s is 4.2 GB at 24 fps and 8.4 GB at 48, against a 6.85 GB ceiling.
  it("prices an upscale at the rate the chain will produce", async () => {
    expect(await run(["MODULE_FINISH_RIFE", "MODULE_U"], [{ interpolation_factor: 2 }, { scale: 2 }])).toBe(0);
  });
  it("CONTROL: the same upscale with no interpolation runs", async () => {
    expect(await run(["MODULE_U"], [{ scale: 2 }])).toBe(1);
  });
});
