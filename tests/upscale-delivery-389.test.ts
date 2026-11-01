import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceFilmJob, filmJobDocKey, resolveAssembleDelivery, resolveFilmFrame, type FilmJob } from "../src/film-orchestrator.js";
import { clipJobDocKey, finishTargetFrame, predictScaledFrame, summarizeFinish } from "../src/film-model.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { RegisteredModule } from "../src/modules/types.js";

// core#389: a paid upscale reaches the film, or the summary says it did not.
// Measured on film-6e71cf89: a 1344x768 clip went to 2688x1536 at 45 MB, and assemble scaled it back.

afterEach(() => vi.restoreAllMocks());

/** A real box tree, so the production parser reads the size: ftyp, moov(mvhd, trak(tkhd, mdia(hdlr))). */
function mp4(width: number, height: number): Uint8Array {
  const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const mvhd = new Uint8Array(100);
  new DataView(mvhd.buffer).setUint32(12, 1000);
  new DataView(mvhd.buffer).setUint32(16, 6000);
  const tkhd = new Uint8Array(84);
  new DataView(tkhd.buffer).setUint32(76, width * 65536);
  new DataView(tkhd.buffer).setUint32(80, height * 65536);
  const hdlr = new Uint8Array(24);
  hdlr.set([0x76, 0x69, 0x64, 0x65], 8);
  const moov = box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd), box("mdia", box("hdlr", hdlr))));
  const ftyp = box("ftyp", new Uint8Array(8));
  const pad = box("free", new Uint8Array(4096));
  const out = new Uint8Array(ftyp.length + moov.length + pad.length);
  out.set(ftyp, 0); out.set(moov, ftyp.length); out.set(pad, ftyp.length + moov.length);
  return out;
}

function env(clips: Record<string, Uint8Array>, docs: Record<string, unknown>, bindings: Record<string, unknown> = {}) {
  const text: Record<string, string> = {};
  for (const [k, v] of Object.entries(docs)) text[k] = JSON.stringify(v);
  const e = {
    R2_RENDERS: {
      head: async (k: string) => (k in clips ? { size: clips[k].length } : k in text ? { size: 1 } : null),
      get: async (k: string, opts?: { range?: { offset: number; length: number } }) => {
        if (k in clips) {
          const off = opts?.range?.offset ?? 0;
          const slice = clips[k].slice(off, off + (opts?.range?.length ?? clips[k].length));
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
  return { e, text };
}

const clipDoc = (w: number, h: number, seconds = 6) => ({
  job_id: "c",
  shots: [{ shot_id: "s1", status: "done", delivered_width: w, delivered_height: h, delivered_frames: seconds * 24, delivered_fps: 24 }],
});
const shot = (over: Record<string, unknown> = {}) => ({
  shot_id: "s1", clip_key: "renders/p/clips/s1_up.mp4", chain: ["MODULE_U"], configs: [{}], idx: 1, status: "done", applied: ["upscale:2x"], ...over,
});
const job = (over: Partial<FilmJob> = {}): FilmJob => ({
  film_id: "film-1", project: "p", phase: "assemble", created_at: 1, scenes: [], bundle_key: "b", clip_job_id: "c", ...over,
}) as unknown as FilmJob;
const CLIP_DOC = clipJobDocKey("c");

describe("finishTargetFrame", () => {
  it.each([
    [{ width: 1344, height: 768 }, { width: 1890, height: 1080 }],
    [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }],
    [{ width: 720, height: 1280 }, { width: 1080, height: 1920 }],
    [{ width: 864, height: 1536 }, { width: 1080, height: 1920 }],
    [{ width: 1024, height: 1024 }, { width: 1080, height: 1080 }],
  ])("%o aims at %o", (source, want) => {
    expect(finishTargetFrame({}, source)).toEqual(want);
  });
  it("a vertical clip keeps a vertical target", () => {
    const t = finishTargetFrame({}, { width: 720, height: 1280 });
    expect(t.height).toBeGreaterThan(t.width);
  });
  it("an operator pair wins, and no measurement is the labelled default", () => {
    expect(finishTargetFrame({ delivery_width: 640, delivery_height: 360 }, { width: 720, height: 1280 })).toEqual({ width: 640, height: 360 });
    expect(finishTargetFrame({}, undefined)).toEqual({ width: 1920, height: 1080 });
  });
  it("a scale in the config is a factor, otherwise the target", () => {
    const src = { width: 1344, height: 768 }, target = { width: 1890, height: 1080 };
    expect(predictScaledFrame(src, target, { scale: 2 })).toEqual({ width: 2688, height: 1536 });
    expect(predictScaledFrame(src, target, { scale: 0 })).toEqual(target);
    expect(predictScaledFrame(src, target, {})).toEqual(target);
    expect(predictScaledFrame(undefined, target, { scale: 2 })).toEqual(target);
  });
});

describe("the frame assemble builds", () => {
  it("is the upscaled clip's, not the clip doc's (the measured film-6e71cf89 case)", async () => {
    const { e } = env({ "renders/p/clips/s1_up.mp4": mp4(2688, 1536) }, { [CLIP_DOC]: clipDoc(1344, 768) });
    const j = job({ finish_shots: [shot()] as never });
    expect(await resolveFilmFrame(e, j)).toMatchObject({ width: 2688, height: 1536 });
    expect(j.assemble_frame).toEqual({ width: 2688, height: 1536 });
    expect(summarizeFinish(j.finish_shots!).degraded).toBe(0);
  });

  it("a vertical upscale stays vertical, and film.finish reads the same frame (core#375 holds)", async () => {
    const { e } = env({ "renders/p/clips/s1_up.mp4": mp4(1080, 1920) }, { [CLIP_DOC]: clipDoc(720, 1280) });
    const j = job({ finish_shots: [shot()] as never });
    expect(await resolveFilmFrame(e, j)).toMatchObject({ width: 1080, height: 1920 });
    expect(await resolveAssembleDelivery(e, { clip_job_id: "c", assemble_frame: j.assemble_frame } as FilmJob))
      .toMatchObject({ width: 1080, height: 1920 });
  });

  it("a vertical film with no upscale is the clip's frame, with no extra read of the clip", async () => {
    const { e } = env({}, { [CLIP_DOC]: clipDoc(720, 1280) });
    const j = job({ finish_shots: [shot({ clip_key: "c.mp4", applied: ["noop:no-dialogue"] })] as never });
    expect(await resolveFilmFrame(e, j)).toMatchObject({ width: 720, height: 1280 });
    expect(j.finish_shots![0].degraded).toBeUndefined();
  });

  it("a passthrough upscale measures nothing and stays at the clip's frame", async () => {
    const { e } = env({}, { [CLIP_DOC]: clipDoc(1344, 768) });
    const j = job({ finish_shots: [shot({ clip_key: "c.mp4", applied: ["passthrough:door-down"] })] as never });
    expect(await resolveFilmFrame(e, j)).toMatchObject({ width: 1344, height: 768 });
  });

  it("an operator target below the clip is named in the summary", async () => {
    const { e } = env({ "renders/p/clips/s1_up.mp4": mp4(2688, 1536) }, { [CLIP_DOC]: clipDoc(1344, 768) });
    const j = job({ delivery_width: 1344, delivery_height: 768, finish_shots: [shot()] as never });
    expect(await resolveFilmFrame(e, j)).toMatchObject({ width: 1344, height: 768, basis: "operator-override" });
    const s = summarizeFinish(j.finish_shots!);
    expect(s.degraded).toBe(1);
    expect(s.reasons[0]).toBe("finished clip is 2688x1536, delivered at 1344x768");
  });

  it("a clip a little over the target is not a limit: 1936 into 1920", async () => {
    const { e } = env({ "renders/p/clips/s1_up.mp4": mp4(1936, 1080) }, { [CLIP_DOC]: clipDoc(832, 464) });
    const j = job({ delivery_width: 1920, delivery_height: 1080, finish_shots: [shot()] as never });
    await resolveFilmFrame(e, j);
    expect(summarizeFinish(j.finish_shots!).degraded).toBe(0);
  });

  it("just past the tolerance it is named", async () => {
    const { e } = env({ "renders/p/clips/s1_up.mp4": mp4(1980, 1080) }, { [CLIP_DOC]: clipDoc(832, 464) });
    const j = job({ delivery_width: 1920, delivery_height: 1080, finish_shots: [shot()] as never });
    await resolveFilmFrame(e, j);
    expect(summarizeFinish(j.finish_shots!).degraded).toBe(1);
  });

  it("a finished clip that cannot be measured is named, and never reads as delivered", async () => {
    const { e } = env({}, { [CLIP_DOC]: clipDoc(1344, 768) });
    const j = job({ finish_shots: [shot()] as never });
    expect(await resolveFilmFrame(e, j)).toMatchObject({ width: 1344, height: 768 });
    expect(summarizeFinish(j.finish_shots!).reasons[0]).toMatch(/could not be measured/);
  });

  it("a later tick reads the recorded frame and pays no read", async () => {
    const made = env({ "renders/p/clips/s1_up.mp4": mp4(2688, 1536) }, { [CLIP_DOC]: clipDoc(1344, 768) });
    const j = job({ finish_shots: [shot()] as never, assemble_frame: { width: 1890, height: 1080 } });
    const spy = vi.spyOn(made.e.R2_RENDERS as { get: (k: string) => Promise<unknown> }, "get");
    expect(await resolveFilmFrame(made.e, j)).toMatchObject({ width: 1890, height: 1080 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the assemble door", () => {
  const assemble = async (clips: Record<string, Uint8Array>, doc: unknown, over: Partial<FilmJob>) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bodies: { width?: number; height?: number }[] = [];
    const door = {
      fetch: async (url: string, init: RequestInit = {}) => {
        if (new URL(url).pathname === "/async/finish") {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({ ok: true, jobId: "j" }, { status: 202 });
        }
        return Response.json({ status: "running" });
      },
    };
    const j = job({ scenes: [{ shot_id: "s1", prompt: "p", seconds: 6 }] as never, phase_started_at: Date.now(), last_progress_at: Date.now(), ...over });
    const { e } = env(clips, { [CLIP_DOC]: doc, [filmJobDocKey("film-1")]: j }, {
      DB: undefined, MEDIA_FINISH_TOKEN: "t", VIDEO_FINISH_URL: "http://vf", MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door },
    });
    const r = await advanceFilmJob(e, "film-1", []);
    return { bodies, job: r!.job };
  };

  it("is asked for the upscaled frame", async () => {
    const { bodies, job: after } = await assemble({ "renders/p/clips/s1_up.mp4": mp4(2688, 1536) }, clipDoc(1344, 768), { finish_shots: [shot()] as never });
    expect(bodies[0]).toMatchObject({ width: 2688, height: 1536 });
    expect(after.assemble_frame).toEqual({ width: 2688, height: 1536 });
  });

  it("a vertical film with no upscale is asked for its own frame", async () => {
    const { bodies } = await assemble({}, clipDoc(720, 1280), { finish_shots: [shot({ clip_key: "renders/p/clips/s1.mp4", applied: ["noop:x"] })] as never });
    expect(bodies[0]).toMatchObject({ width: 720, height: 1280 });
  });

  it("the budget sees the larger frame, so a long upscaled film is refused and not sized from the clip doc", async () => {
    const { bodies, job: after } = await assemble({ "renders/p/clips/s1_up.mp4": mp4(2688, 1536) }, clipDoc(1344, 768, 5400), { finish_shots: [shot()] as never });
    expect(bodies).toHaveLength(0);
    expect(after.error).toMatch(/at 2688x1536/);
  });
});

describe("the finish step, before it spends", () => {
  const U = { name: "finish-upscale", version: "1", api: "vivijure-module/2", hooks: ["finish"], ui: { section: "finish", order: 1 }, binding: "MODULE_U", finish_scales_frame: true } as unknown as RegisteredModule;
  const run = async (w: number, h: number, seconds: number, config: Record<string, unknown>, mod: RegisteredModule = U) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bodies: Record<string, unknown>[] = [];
    const door = {
      fetch: async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/module.json")) return Response.json(mod);
        const raw = typeof input === "string" ? String(init?.body) : await input.text();
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        return Response.json({ ok: true, pending: true, poll: "t" });
      },
    };
    const j = job({
      phase: "finish", phase_started_at: Date.now(), last_progress_at: Date.now(),
      finish_shots: [{ shot_id: "s1", clip_key: "renders/p/clips/s1.mp4", chain: ["MODULE_U"], configs: [config], idx: 0, status: "pending", applied: [] }] as never,
    });
    const { e } = env({}, { [CLIP_DOC]: clipDoc(w, h, seconds), [filmJobDocKey("film-1")]: j }, { MODULE_U: door });
    const r = await advanceFilmJob(e, "film-1", [mod]);
    return { job: r!.job, bodies };
  };

  it("sends the target for the clip's shape, landscape and vertical", async () => {
    const land = await run(1344, 768, 6, {});
    expect(land.bodies).toHaveLength(1);
    expect((land.bodies[0].input as Record<string, unknown>)).toMatchObject({ delivery_width: 1890, delivery_height: 1080 });
    const vert = await run(720, 1280, 6, {});
    expect((vert.bodies[0].input as Record<string, unknown>)).toMatchObject({ delivery_width: 1080, delivery_height: 1920 });
  });

  it("refuses a 90 minute film at 2x by name, calls no door, and keeps the clip", async () => {
    const { job: after, bodies } = await run(1344, 768, 5400, { scale: 2 });
    expect(bodies).toHaveLength(0);
    expect(after.finish_incomplete?.[0]).toMatchObject({ stage: "finish", step: "MODULE_U", code: "assemble_budget", shot_id: "s1" });
    expect(after.finish_incomplete?.[0].detail).toMatch(/5400s film at 2688x1536 cannot fit the assemble budget/);
    expect(after.finish_shots![0]).toMatchObject({ status: "done", clip_key: "renders/p/clips/s1.mp4" });
  });

  it("a length that fits 1080 is admitted at the default target, and refused at 2x", async () => {
    const fits = await run(1344, 768, 3600, {});
    expect(fits.bodies).toHaveLength(1);
    expect(fits.job.finish_incomplete ?? []).toEqual([]);
    const over = await run(1344, 768, 3600, { scale: 2 });
    expect(over.bodies).toHaveLength(0);
    expect(over.job.finish_incomplete?.[0].code).toBe("assemble_budget");
  });

  it("a module that does not declare it is not priced", async () => {
    const { bodies } = await run(1344, 768, 5400, { scale: 2 }, { ...U, finish_scales_frame: undefined } as RegisteredModule);
    expect(bodies).toHaveLength(1);
  });

  it("the summary reads the refusal, and the film is not refused for it", async () => {
    const { job: after } = await run(1344, 768, 5400, { scale: 2 });
    expect(summarizeFinish(after.finish_shots!).reasons[0]).toMatch(/cannot fit the assemble budget/);
    expect(after.error ?? "").not.toMatch(/finish failed/);
  });
});
