// core#379: a film's finish steps write under that film, so one render cannot replace a clip another
// render has recorded. Same class as the still collision in vivijure-backend#535.
import { describe, expect, it, vi } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { finishClipScope, finishStepIsShotNamed, finishStepOutputKey, finishStepPointerKey, type FinishShot } from "../src/film-model.js";
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

  it("a suffix step is not scoped, and its shape is recorded rather than changed", () => {
    expect(finishStepOutputKey("p", shot({ chain: ["MODULE_U"] }), [UP], "film-a")).toBe("renders/p/clips/s1_own-gpu_up.mp4");
    expect(finishStepIsShotNamed(shot({ chain: ["MODULE_U"] }), [UP])).toBe(false);
  });

  it("a legacy RIFE binding with no declaration is shot-named too", () => {
    expect(finishStepOutputKey("p", shot({ chain: ["MODULE_RIFE"] }), [], "film-a")).toBe("renders/p/clips/film-a/s1_finished.mp4");
  });

  it("names the pointer beside the shared key, and only for a shot-named step", () => {
    expect(finishStepPointerKey("p", shot(), [RIFE])).toBe("renders/p/clips/s1_finished.latest.json");
    expect(finishStepPointerKey("p", shot({ chain: ["MODULE_U"] }), [UP])).toBeNull();
  });

  it("no scope still gives the shared key, which adoption reads as the fallback", () => {
    expect(finishStepOutputKey("p", shot(), [RIFE])).toBe("renders/p/clips/s1_finished.mp4");
  });

  it("a module with no convention still gets no key", () => {
    expect(finishStepOutputKey("p", shot({ chain: ["MODULE_X"] }), [], "film-a")).toBeNull();
  });
});

function world(job: Partial<FilmJob>, moduleBody: (input: Record<string, unknown>, path: string) => unknown, stored: Record<string, string> = {}, failPut?: (k: string) => boolean) {
  const inputs: Record<string, unknown>[] = [];
  const store: Record<string, string> = { ...stored };
  const doc = { film_id: "film-a", project: "p", phase: "finish", created_at: Date.now() - 1000, phase_started_at: Date.now(), scenes: [], bundle_key: "b", ...job };
  store[filmJobDocKey("film-a")] = JSON.stringify(doc);
  const e = {
    R2_RENDERS: {
      head: async (k: string) => (k in store ? { size: 4096, etag: "e" } : null),
      get: async (k: string) => (k in store ? { body: store[k], text: async () => store[k], arrayBuffer: async () => { throw new Error("buffered a whole clip"); } } : null),
      put: async (k: string, b: string) => { if (failPut?.(k)) throw new Error("put refused"); store[k] = b; },
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

  it("reuses another film's clip only through the pointer, and only with a matching hash", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = "renders/p/clips/film-b/s1_finished.mp4";
    const pointer = "renders/p/clips/s1_finished.latest.json";
    const hash = await import("../src/finish-hash.js");
    const good = await hash.finishStepInputHash(null, null, {});

    const noPointer = world({ finish_shots: [shot({ poll: "tok" })] as never }, lostPoll, { [other]: "clip", [`${other}.hash`]: good });
    expect((await advanceFilmJob(noPointer.e, "film-a", [RIFE]))?.job.finish_shots![0].clip_key).not.toBe(other);

    const stale = world({ finish_shots: [running] as never }, lostPoll, { [other]: "clip", [`${other}.hash`]: "different", [pointer]: JSON.stringify({ key: other }) });
    expect((await advanceFilmJob(stale.e, "film-a", [RIFE]))?.job.finish_shots![0].clip_key).toBe(running.clip_key);

    const ok = world({ finish_shots: [running] as never }, lostPoll, { [other]: "clip", [`${other}.hash`]: good, [pointer]: JSON.stringify({ key: other }) });
    const own = "renders/p/clips/film-a/s1_finished.mp4";
    expect((await advanceFilmJob(ok.e, "film-a", [RIFE]))?.job.finish_shots![0].clip_key).toBe(own);
    expect(ok.store[own]).toBe("clip");
    expect(ok.store[`${own}.hash`]).toBe(good);
    expect(ok.store[other]).toBe("clip"); // the other film keeps its own
  });

  it("a film that reuses a clip survives the other film being gone: it holds no reference to it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = "renders/p/clips/film-b/s1_finished.mp4";
    const hash = await import("../src/finish-hash.js");
    const good = await hash.finishStepInputHash(null, null, {});
    const w = world({ finish_shots: [running] as never }, lostPoll, { [other]: "clip", [`${other}.hash`]: good, "renders/p/clips/s1_finished.latest.json": JSON.stringify({ key: other }) });
    const r = await advanceFilmJob(w.e, "film-a", [RIFE]);
    expect(JSON.stringify(r?.job)).not.toContain("film-b");
  });

  it("a copy that fails means the step runs, and records nothing it does not own", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = "renders/p/clips/film-b/s1_finished.mp4";
    const own = "renders/p/clips/film-a/s1_finished.mp4";
    const hash = await import("../src/finish-hash.js");
    const good = await hash.finishStepInputHash(null, null, {});
    for (const refused of [own, `${own}.hash`]) {
      const w = world({ finish_shots: [running] as never }, lostPoll,
        { [other]: "clip", [`${other}.hash`]: good, "renders/p/clips/s1_finished.latest.json": JSON.stringify({ key: other }) },
        (k) => k === refused);
      const s = (await advanceFilmJob(w.e, "film-a", [RIFE]))?.job.finish_shots![0];
      expect(s?.clip_key).toBe(running.clip_key);
      expect(s?.idx).toBe(0);
      expect(w.store[own]).toBeUndefined();
      expect(w.store[`${own}.hash`]).toBeUndefined();
    }
  });

  it("a pointer whose target is gone means the step runs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ finish_shots: [running] as never }, lostPoll,
      { "renders/p/clips/s1_finished.latest.json": JSON.stringify({ key: "renders/p/clips/film-b/s1_finished.mp4" }) });
    const s = (await advanceFilmJob(w.e, "film-a", [RIFE]))?.job.finish_shots![0];
    expect(s?.clip_key).toBe(running.clip_key);
    expect(s?.idx).toBe(0);
  });

  it("the copy does not buffer the clip: the fake throws if anything calls arrayBuffer", async () => {
    const { copyClipWithSidecar } = await import("../src/r2-copy.js");
    const a = "renders/p/clips/film-b/s1.mp4", b = "renders/p/clips/film-a/s1.mp4";
    const w = world({}, () => ({}), { [a]: "clip", [`${a}.hash`]: "h" });
    await expect(copyClipWithSidecar((w.e as unknown as { R2_RENDERS: never }).R2_RENDERS, a, b)).resolves.toBe(true);
  });

  it.each([
    ["another project", "renders/q/clips/film-b/s1_finished.mp4"],
    ["not a clip", "renders/p/keyframes/s1.mp4"],
    ["not a video", "renders/p/clips/film-b/s1.json"],
    ["traversal", "renders/p/clips/../../q/s1.mp4"],
  ])("refuses a pointer naming %s", async (_name, key) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hash = await import("../src/finish-hash.js");
    const good = await hash.finishStepInputHash(null, null, {});
    const w = world({ finish_shots: [running] as never }, lostPoll, { [key]: "clip", [`${key}.hash`]: good, "renders/p/clips/s1_finished.latest.json": JSON.stringify({ key }) });
    const s = (await advanceFilmJob(w.e, "film-a", [RIFE]))?.job.finish_shots![0];
    // Not `not.toBe(key)`: since a reused clip is copied, a followed pointer records the film's own key.
    expect(s?.clip_key).toBe(running.clip_key);
    expect(s?.idx).toBe(0);
    expect(w.store["renders/p/clips/film-a/s1_finished.mp4"]).toBeUndefined();
  });

  it("a corrupt pointer only means the step is not reused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ finish_shots: [running] as never }, lostPoll, { "renders/p/clips/s1_finished.latest.json": "{not json" });
    expect((await advanceFilmJob(w.e, "film-a", [RIFE]))?.job).toBeTruthy();
  });
});
