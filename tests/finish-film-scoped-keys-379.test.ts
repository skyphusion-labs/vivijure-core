// core#379: a film's finish steps write under that film, so one render cannot replace a clip another
// render has recorded. Same class as the still collision in vivijure-backend#535.
import { describe, expect, it, vi } from "vitest";
import { FINISH_REUSE_COPIES_PER_TICK, FINISH_REUSE_LOOKUPS_PER_TICK, advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
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

  it("never copies over the film's own clip, and a failed copy never deletes it (driven by review)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = "renders/p/clips/film-b/s1_finished.mp4";
    const own = "renders/p/clips/film-a/s1_finished.mp4";
    const hash = await import("../src/finish-hash.js");
    const good = await hash.finishStepInputHash(null, null, {});
    // The window between the film's own clip write and its sidecar write: the clip is there, no hash.
    for (const failPut of [undefined, (k: string) => k === own]) {
      const w = world({ finish_shots: [running] as never }, lostPoll,
        { [own]: "my own clip", [other]: "their clip", [`${other}.hash`]: good, "renders/p/clips/s1_finished.latest.json": JSON.stringify({ key: other }) },
        failPut);
      const s = (await advanceFilmJob(w.e, "film-a", [RIFE]))?.job.finish_shots![0];
      expect(w.store[own]).toBe("my own clip");
      expect(s?.clip_key).toBe(running.clip_key);
    }
  });

  it("a failed copy deletes only what it wrote", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { copyClipWithSidecar } = await import("../src/r2-copy.js");
    const a = "renders/p/clips/film-b/s1.mp4", b = "renders/p/clips/film-a/s1.mp4";
    const deleted: string[] = [];
    const bucket = {
      head: async (k: string) => (k === a ? { size: 1 } : null),
      get: async (k: string) => ({ body: "x", text: async () => k }),
      put: async () => { throw new Error("no"); },
      delete: async (k: string) => { deleted.push(k); },
    };
    await expect(copyClipWithSidecar(bucket as never, a, b)).resolves.toBe(false);
    expect(deleted).toEqual([b]);
  });

  it("a film larger than the per-tick bound stays under it and ends complete", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hash = await import("../src/finish-hash.js");
    const good = await hash.finishStepInputHash(null, null, {});
    const ids = Array.from({ length: 11 }, (_, i) => `s${i + 1}`);
    const stored: Record<string, string> = {};
    for (const id of ids) {
      const other = `renders/p/clips/film-b/${id}_finished.mp4`;
      stored[other] = "clip";
      stored[`${other}.hash`] = good;
      stored[`renders/p/clips/${id}_finished.latest.json`] = JSON.stringify({ key: other });
    }
    const shots = ids.map((id) => shot({ shot_id: id, clip_key: `renders/p/clips/${id}.mp4`, poll: "tok" }));
    const w = world({ finish_shots: shots as never, clips_only: true }, () => ({ ok: true, pending: true }), stored);
    const copied = () => ids.filter((id) => w.store[`renders/p/clips/film-a/${id}_finished.mp4`]).length;
    let ticks = 0;
    let before = 0;
    let phase: string | undefined = "finish";
    while (phase === "finish" && ticks < 30) {
      phase = (await advanceFilmJob(w.e, "film-a", [RIFE]))?.job.phase;
      ticks += 1;
      expect(copied() - before).toBeLessThanOrEqual(FINISH_REUSE_COPIES_PER_TICK);
      before = copied();
    }
    expect(phase).toBe("done");
    expect(copied()).toBe(ids.length);
    expect(ticks).toBeLessThanOrEqual(Math.ceil(ids.length / FINISH_REUSE_COPIES_PER_TICK) + 1);
    const done = JSON.parse(w.store[filmJobDocKey("film-a")]) as FilmJob;
    expect(JSON.stringify(done.finish_shots)).not.toContain("film-b");
  });

  it("reads at most the bound of pointers in a tick, and still reaches a shot behind the bound", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hash = await import("../src/finish-hash.js");
    const good = await hash.finishStepInputHash(null, null, {});
    const ids = Array.from({ length: 9 }, (_, i) => `s${i + 1}`);
    const other = "renders/p/clips/film-b/s9_finished.mp4";
    // Only the last shot has anything to reuse. Without a moving start, the first shots would spend the
    // lookups on every tick, and it would never be reached.
    const stored = { [other]: "clip", [`${other}.hash`]: good, "renders/p/clips/s9_finished.latest.json": JSON.stringify({ key: other }) };
    const shots = ids.map((id) => shot({ shot_id: id, clip_key: `renders/p/clips/${id}.mp4`, poll: "tok" }));
    const w = world({ finish_shots: shots as never }, () => ({ ok: true, pending: true }), stored);
    const bucket = (w.e as unknown as { R2_RENDERS: { get: (k: string) => Promise<unknown> } }).R2_RENDERS;
    const realGet = bucket.get;
    let pointerReads = 0;
    bucket.get = async (k: string) => { if (k.endsWith(".latest.json")) pointerReads += 1; return realGet(k); };
    let reached = false;
    for (let tick = 0; tick < 4 && !reached; tick++) {
      pointerReads = 0;
      const r = await advanceFilmJob(w.e, "film-a", [RIFE]);
      expect(pointerReads).toBeLessThanOrEqual(FINISH_REUSE_LOOKUPS_PER_TICK);
      reached = r!.job.finish_shots![8].clip_key === "renders/p/clips/film-a/s9_finished.mp4";
    }
    expect(reached).toBe(true);
  });

  it("failed shots past the bound are copied a few a tick, and the film does not fail for the wait", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hash = await import("../src/finish-hash.js");
    const good = await hash.finishStepInputHash(null, null, {});
    const ids = Array.from({ length: 6 }, (_, i) => `s${i + 1}`);
    const stored: Record<string, string> = {};
    for (const id of ids) {
      const other = `renders/p/clips/film-b/${id}_finished.mp4`;
      stored[other] = "clip";
      stored[`${other}.hash`] = good;
      stored[`renders/p/clips/${id}_finished.latest.json`] = JSON.stringify({ key: other });
    }
    const shots = ids.map((id) => shot({ shot_id: id, clip_key: `renders/p/clips/${id}.mp4`, status: "failed", error: "x" } as never));
    const w = world({ finish_shots: shots as never, clips_only: true }, () => ({ ok: true }), stored);
    const copied = () => ids.filter((id) => w.store[`renders/p/clips/film-a/${id}_finished.mp4`]).length;
    let before = 0;
    let phase: string | undefined = "finish";
    let ticks = 0;
    while (phase === "finish" && ticks < 12) {
      phase = (await advanceFilmJob(w.e, "film-a", [RIFE]))?.job.phase;
      ticks += 1;
      expect(copied() - before).toBeLessThanOrEqual(FINISH_REUSE_COPIES_PER_TICK);
      before = copied();
    }
    expect(phase).toBe("done");
    expect(copied()).toBe(ids.length);
  });

  it("a failed shot with nothing to reuse still fails the film once its turn has passed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ finish_shots: [shot({ status: "failed", error: "x" } as never)] as never }, () => ({ ok: true }));
    expect((await advanceFilmJob(w.e, "film-a", [RIFE]))?.job.phase).toBe("failed");
  });

  it("a lost poll past the bound stays pending, and is not failed for the wait", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hash = await import("../src/finish-hash.js");
    const good = await hash.finishStepInputHash(null, null, {});
    const ids = Array.from({ length: 7 }, (_, i) => `s${i + 1}`);
    const stored: Record<string, string> = {};
    for (const id of ids) {
      const other = `renders/p/clips/film-b/${id}_finished.mp4`;
      stored[other] = "clip";
      stored[`${other}.hash`] = good;
      stored[`renders/p/clips/${id}_finished.latest.json`] = JSON.stringify({ key: other });
    }
    const shots = ids.map((id) => shot({ shot_id: id, clip_key: `renders/p/clips/${id}.mp4`, poll: "tok", chain: ["MODULE_R", "MODULE_R"] }));
    const w = world({ finish_shots: shots as never }, lostPoll, stored);
    const r = await advanceFilmJob(w.e, "film-a", [RIFE]);
    expect(r?.job.finish_shots!.filter((s) => s.status === "failed")).toEqual([]);
    expect(r?.job.phase).toBe("finish");
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
