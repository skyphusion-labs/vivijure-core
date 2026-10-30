// core#379: a film's finish steps write under that film, so one render cannot replace a clip another
// render has recorded. Same class as the still collision in vivijure-backend#535.
import { describe, expect, it, vi } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { finishClipScope, finishStepOutputKey, type FinishShot } from "../src/film-model.js";
import type { RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

const RIFE = { name: "finish-rife", version: "1", api: "vivijure-module/2", hooks: ["finish"], binding: "MODULE_R",
  ui: { section: "finish", order: 1 }, finish_artifacts: { output_key: { kind: "shot_named", filename: "_finished.mp4" }, applied: [] } } as unknown as RegisteredModule;
const UP = { name: "finish-upscale", version: "1", api: "vivijure-module/2", hooks: ["finish"], binding: "MODULE_U",
  ui: { section: "finish", order: 2 }, finish_artifacts: { output_key: { kind: "append_suffix", suffix: "_up" }, applied: [] } } as unknown as RegisteredModule;

const shot = (over: Partial<FinishShot> = {}): FinishShot =>
  ({ shot_id: "s1", clip_key: "renders/p/clips/s1_own-gpu.mp4", chain: ["MODULE_R"], configs: [{}], idx: 0, status: "pending", applied: [], ...over }) as FinishShot;

describe("the key", () => {
  it("two films get different keys for one shot", () => {
    const a = finishStepOutputKey("p", shot(), [RIFE], finishClipScope({ film_id: "film-a" }));
    const b = finishStepOutputKey("p", shot(), [RIFE], finishClipScope({ film_id: "film-b" }));
    expect(a).toBe("renders/p/clips/film-a/s1_finished.mp4");
    expect(b).toBe("renders/p/clips/film-b/s1_finished.mp4");
  });

  it("a retry gets its own folder under the film", () => {
    expect(finishClipScope({ film_id: "film-a", finish_retry_gen: 2 })).toBe("film-a/r2");
  });

  it("a suffix step moves a shared input under the film, and stays there for the next step", () => {
    const first = finishStepOutputKey("p", shot({ chain: ["MODULE_U"] }), [UP], "film-a");
    expect(first).toBe("renders/p/clips/film-a/s1_own-gpu_up.mp4");
    const next = finishStepOutputKey("p", shot({ chain: ["MODULE_U"], clip_key: "renders/p/clips/film-a/s1_finished.mp4" }), [UP], "film-a");
    expect(next).toBe("renders/p/clips/film-a/s1_finished_up.mp4");
  });

  it("no scope still gives the shared key, which adoption reads as the fallback", () => {
    expect(finishStepOutputKey("p", shot(), [RIFE])).toBe("renders/p/clips/s1_finished.mp4");
  });

  it("a module with no convention still gets no key", () => {
    expect(finishStepOutputKey("p", shot({ chain: ["MODULE_X"] }), [], "film-a")).toBeNull();
  });
});

function world(job: Partial<FilmJob>, moduleBody: (input: Record<string, unknown>, path: string) => unknown, stored: Record<string, string> = {}) {
  const inputs: Record<string, unknown>[] = [];
  const store: Record<string, string> = { ...stored };
  const doc = { film_id: "film-a", project: "p", phase: "finish", created_at: Date.now() - 1000, phase_started_at: Date.now(), scenes: [], bundle_key: "b", ...job };
  store[filmJobDocKey("film-a")] = JSON.stringify(doc);
  const e = {
    R2_RENDERS: {
      head: async (k: string) => (k in store ? { size: 4096, etag: "e" } : null),
      get: async (k: string) => (k in store ? { text: async () => store[k], arrayBuffer: async () => new ArrayBuffer(0) } : null),
      put: async (k: string, b: string) => { store[k] = b; },
      delete: async (k: string) => { delete store[k]; },
      list: async ({ prefix }: { prefix: string }) => ({ objects: Object.keys(store).filter((k) => k.startsWith(prefix)).map((key) => ({ key, uploaded: new Date() })), truncated: false }),
    },
    MODULE_R: {
      fetch: async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/module.json")) return Response.json(RIFE);
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
        if (body.input) inputs.push(body.input);
        return Response.json(moduleBody(body.input ?? {}, new URL(url).pathname));
      },
    },
  } as unknown as Env;
  return { e, inputs, store };
}

describe("a real tick", () => {
  it("sends the film's key to the module even when no presigner is bound", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { e, inputs } = world({ finish_shots: [shot()] as never }, () => ({ ok: true, pending: true, poll: "tok" }));
    await advanceFilmJob(e, "film-a", [RIFE]);
    expect(inputs[0].output_key).toBe("renders/p/clips/film-a/s1_finished.mp4");
  });

  it("a retry sends the retry's key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { e, inputs } = world({ finish_retry_gen: 3, finish_shots: [shot()] as never }, () => ({ ok: true, pending: true, poll: "tok" }));
    await advanceFilmJob(e, "film-a", [RIFE]);
    expect(inputs[0].output_key).toBe("renders/p/clips/film-a/r3/s1_finished.mp4");
  });

  const lostPoll = (input: Record<string, unknown>, path: string) =>
    path === "/poll" ? { ok: false, error: "job gone" } : { ok: true, pending: true, poll: "tok" };
  const running = shot({ poll: "tok", chain: ["MODULE_R", "MODULE_R"], idx: 0 });

  it("after a lost poll it adopts the film's own clip", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const own = "renders/p/clips/film-a/s1_finished.mp4";
    const { e, store } = world({ finish_shots: [running] as never }, lostPoll, { [own]: "clip", [`${own}.hash`]: "x" });
    const hash = await import("../src/finish-hash.js");
    store[`${own}.hash`] = await hash.finishStepInputHash(null, null, {});
    const r = await advanceFilmJob(e, "film-a", [RIFE]);
    expect(r?.job.finish_shots![0].clip_key).toBe(own);
  });

  it("after a lost poll it falls back to the shared key an older backend wrote", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const flat = "renders/p/clips/s1_finished.mp4";
    const { e, store } = world({ finish_shots: [running] as never }, lostPoll, { [flat]: "clip" });
    const hash = await import("../src/finish-hash.js");
    store[`${flat}.hash`] = await hash.finishStepInputHash(null, null, {});
    const r = await advanceFilmJob(e, "film-a", [RIFE]);
    expect(r?.job.finish_shots![0].clip_key).toBe(flat);
  });

  it("never adopts another film's clip, even with a matching hash", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = "renders/p/clips/film-b/s1_finished.mp4";
    const { e, store } = world({ finish_shots: [shot({ poll: "tok" })] as never }, lostPoll, { [other]: "clip" });
    const hash = await import("../src/finish-hash.js");
    store[`${other}.hash`] = await hash.finishStepInputHash(null, null, {});
    const r = await advanceFilmJob(e, "film-a", [RIFE]);
    expect(r?.job.finish_shots![0].clip_key).not.toBe(other);
  });
});
