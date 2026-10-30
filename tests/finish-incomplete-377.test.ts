import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceFilmJob, cancelFilmJob, filmJobDocKey, retryFilmFinish, runFilmFinish, type FilmJob } from "../src/film-orchestrator.js";
import { filmJobToPollView } from "../src/film-render-bridge.js";
import {
  FINISH_STEP_HOLD_MAX_SECONDS,
  FINISH_STEP_MAX_HOLD_CYCLES,
  FINISH_TRANSPORT_HOLD_MAX_SECONDS,
  type HoldableStep,
  acceptHeldStep,
  holdStep,
  phaseCeilingVerdict,
  stampFilmProgress,
  stepFailureOf,
  summarizeFilm,
} from "../src/film-model.js";
import { ASSEMBLE_CAPACITY_MAX_WAIT_SECONDS, decodeAssembleWait, encodeAssembleWait } from "../src/video-finish-assemble.js";
import { sweepUnresolvedJobs } from "../src/render-sweep.js";
import type { FinishQueue } from "../src/finish-queue.js";
import { markFinishDone, reopenRenderForFinishRetry } from "../src/renders-db.js";
import { openTestD1 } from "./helpers/d1-sqlite.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { RegisteredModule } from "../src/modules/types.js";

// A transient failure holds the film. A permanent one, or a wait that ran out, names the step.
// Neither may read as a clean finish, and the named step can run again with no clip re-rendered.

afterEach(() => vi.restoreAllMocks());

const FILM = "renders/p1/film.mp4";
const mod = (name: string, binding: string, hook = "film.finish"): RegisteredModule =>
  ({ name, version: "1", api: "vivijure-module/2", hooks: [hook], ui: { section: "finish", order: 1 }, binding }) as unknown as RegisteredModule;
const TITLES = mod("film-titles", "MODULE_FILM_TITLES");
const SUBTITLE = mod("subtitle", "MODULE_SUBTITLE");

type Out = Record<string, unknown>;
const pass = (reason: string, failure?: Out): Out => ({
  film_key: FILM, applied: [`passthrough:${reason}`], degraded: reason, ...(failure ? { failure } : {}),
});
const CAPACITY = { kind: "transient", code: "capacity" };
const UNREACHABLE = { kind: "transient", code: "unreachable" };
const REFUSED = { kind: "permanent", code: "refused", detail: "bad input" };

/** A module fetcher: answers its manifest, and each invoke from `outputs` or by calling it. */
function fetcher(m: RegisteredModule, output: () => Out | { error: string }) {
  const calls = { invoke: 0 };
  return {
    calls,
    fetch: async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/module.json")) return Response.json(m);
      calls.invoke += 1;
      const o = output();
      return Response.json("error" in o ? { ok: false, error: o.error } : { ok: true, output: o });
    },
  };
}

function env(bindings: Record<string, unknown>, stored: Record<string, string> = {}) {
  const deleted: string[] = [];
  const e = {
    R2_RENDERS: {
      head: async (k: string) => (k in stored ? { size: 4096 } : null),
      get: async (k: string) => (k in stored ? { text: async () => stored[k], arrayBuffer: async () => new ArrayBuffer(0) } : null),
      put: async (k: string, b: string) => { stored[k] = b; },
      delete: async (k: string) => { deleted.push(k); delete stored[k]; },
      list: async () => ({ objects: [] }),
    },
    PRESIGNER: { presignGet: async (k: string) => `https://g/${k}`, presignPut: async (k: string) => `https://p/${k}` },
    ...bindings,
  } as unknown as Env;
  return { e, stored, deleted };
}

interface Harness { wait?: string; skipped: Record<string, never>; polls: Record<string, string> }
function run(e: Env, h: Harness, mods: RegisteredModule[], cards = true) {
  return runFilmFinish(
    e,
    { film_key: FILM, scenes: [], bundle_key: "b", project: "p1", job_id: "film-1", film_titles: cards ? { title: { text: "T" } } : undefined },
    mods,
    {
      polls: h.polls,
      persistPoll: async (k, t) => { if (t === null) delete h.polls[k]; else h.polls[k] = t; },
      dispatched: {},
      persistDispatch: async () => {},
      wait: { get: () => h.wait, set: async (r) => { h.wait = r; } },
      skipped: h.skipped,
    },
  );
}
const harness = (wait?: string): Harness => ({ wait, skipped: {}, polls: {} });
const quiet = () => { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {}); };

describe("stepFailureOf", () => {
  it("reads the structured verdict", () => {
    expect(stepFailureOf({ failure: CAPACITY })).toMatchObject({ kind: "transient", code: "capacity" });
  });
  it("reads an older module's passthrough as permanent, never as clean", () => {
    expect(stepFailureOf({ degraded: "x" })).toMatchObject({ kind: "permanent" });
    expect(stepFailureOf({ applied: ["passthrough:x"] })).toMatchObject({ kind: "permanent" });
  });
  it("a no-op and a success are not failures", () => {
    expect(stepFailureOf({ applied: ["noop:no-cards"] })).toBeNull();
    expect(stepFailureOf({ applied: ["film-titles"] })).toBeNull();
  });
});

describe("film.finish: transient holds", () => {
  it("capacity holds the film in place, records no missing step, and keeps the assembled key", async () => {
    quiet();
    const t = fetcher(TITLES, () => pass("container-failed", CAPACITY));
    const { e } = env({ MODULE_FILM_TITLES: t });
    const h = harness();
    const r = await run(e, h, [TITLES]);
    expect(r.complete).toBe(false);
    expect(r.incomplete).toEqual([]);
    expect(decodeAssembleWait(h.wait)).toMatchObject({ attempts: 1, step: "film-titles" });
  });

  it("does not call the module again inside the wait", async () => {
    quiet();
    const t = fetcher(TITLES, () => pass("x", CAPACITY));
    const { e } = env({ MODULE_FILM_TITLES: t });
    const h = harness();
    await run(e, h, [TITLES]);
    await run(e, h, [TITLES]);
    expect(t.calls.invoke).toBe(1);
  });

  it("an unreachable door stops holding after the short bound and names the step", async () => {
    quiet();
    const t = fetcher(TITLES, () => pass("container-unreachable", UNREACHABLE));
    const { e } = env({ MODULE_FILM_TITLES: t });
    const firstAt = Date.now() - (FINISH_TRANSPORT_HOLD_MAX_SECONDS + 1) * 1000;
    const h = harness(encodeAssembleWait({ firstAt, attempts: 3, nextAt: firstAt, detail: "d" }));
    const r = await run(e, h, [TITLES]);
    expect(r.complete).toBe(true);
    expect(r.incomplete[0]).toMatchObject({ stage: "film.finish", step: "film-titles", code: "wait_exhausted" });
  });

  it("capacity keeps holding well past the transport bound, up to its own", async () => {
    quiet();
    const t = fetcher(TITLES, () => pass("x", CAPACITY));
    const { e } = env({ MODULE_FILM_TITLES: t });
    const firstAt = Date.now() - (FINISH_TRANSPORT_HOLD_MAX_SECONDS + 60) * 1000;
    const h = harness(encodeAssembleWait({ firstAt, attempts: 3, nextAt: firstAt, detail: "d" }));
    expect((await run(e, h, [TITLES])).complete).toBe(false);
    const spent = Date.now() - (ASSEMBLE_CAPACITY_MAX_WAIT_SECONDS + 1) * 1000;
    const h2 = harness(encodeAssembleWait({ firstAt: spent, attempts: 9, nextAt: spent, detail: "d" }));
    const r2 = await run(e, h2, [TITLES]);
    expect(r2.complete).toBe(true);
    expect(r2.incomplete[0].code).toBe("wait_exhausted");
  });

  it("the module worker failing transiently holds too", async () => {
    quiet();
    const t = fetcher(TITLES, () => ({ error: "module worker unreachable" }));
    const { e } = env({ MODULE_FILM_TITLES: t });
    const h = harness();
    expect((await run(e, h, [TITLES])).complete).toBe(false);
  });
});

describe("film.finish: permanent is named, and the chain carries on", () => {
  it("names the step and what is kept, and runs the next one", async () => {
    quiet();
    const t = fetcher(TITLES, () => pass("refused", REFUSED));
    const s = fetcher(SUBTITLE, () => ({ film_key: "renders/p1/film-ff1.mp4", applied: ["subtitle"] }));
    const { e } = env({ MODULE_FILM_TITLES: t, MODULE_SUBTITLE: s });
    const r = await run(e, harness(), [TITLES, SUBTITLE]);
    expect(r.complete).toBe(true);
    expect(r.incomplete).toHaveLength(1);
    expect(r.incomplete[0]).toMatchObject({ step: "film-titles", code: "refused", kept: "the film without this step", step_index: 0 });
    expect(s.calls.invoke).toBe(1);
  });

  it("an older module's bare passthrough is named as well", async () => {
    quiet();
    const t = fetcher(TITLES, () => pass("container-failed"));
    const { e } = env({ MODULE_FILM_TITLES: t });
    expect((await run(e, harness(), [TITLES])).incomplete[0]).toMatchObject({ step: "film-titles", code: "unclassified" });
  });

  it("a no-op is a clean finish", async () => {
    quiet();
    const t = fetcher(TITLES, () => ({ film_key: FILM, applied: ["noop:no-cards"] }));
    const { e } = env({ MODULE_FILM_TITLES: t });
    expect((await run(e, harness(), [TITLES])).incomplete).toEqual([]);
  });

  it("a step given up on does not run again while a later one holds", async () => {
    quiet();
    const t = fetcher(TITLES, () => pass("refused", REFUSED));
    const s = fetcher(SUBTITLE, () => pass("x", CAPACITY));
    const { e } = env({ MODULE_FILM_TITLES: t, MODULE_SUBTITLE: s });
    const h = harness();
    await run(e, h, [TITLES, SUBTITLE]);
    h.wait = undefined;
    await run(e, h, [TITLES, SUBTITLE]);
    expect(t.calls.invoke).toBe(1);
    expect(s.calls.invoke).toBe(2);
  });
});

describe("film.finish and the queue", () => {
  const queue = (over: Partial<FinishQueue>): FinishQueue => ({
    acquire: async () => ({ granted: true, asked_at: 0, running: 0 }),
    renew: async () => {}, yield: async () => {}, release: async () => {}, forget: async () => {}, next: async () => [], holders: async () => [],
    ...over,
  });

  it("a film behind others does not reach the module, and its place is in the wait", async () => {
    quiet();
    const t = fetcher(TITLES, () => ({ film_key: "k", applied: ["film-titles"] }));
    const { e } = env({ MODULE_FILM_TITLES: t, FINISH_QUEUE: queue({ acquire: async () => ({ granted: false, asked_at: 0, running: 19, position: 3, depth: 7 }) }) });
    const h = harness();
    expect((await run(e, h, [TITLES])).complete).toBe(false);
    expect(t.calls.invoke).toBe(0);
    expect(decodeAssembleWait(h.wait)).toMatchObject({ position: 3, depth: 7, queued: true });
  });

  it("a chain with no cards and no captions has nothing to encode, so it never queues", async () => {
    quiet();
    const acquire = vi.fn(async () => ({ granted: false as const, asked_at: 0, running: 19, position: 9, depth: 9 }));
    const t = fetcher(TITLES, () => ({ film_key: FILM, applied: ["noop:no-cards"] }));
    const { e } = env({ MODULE_FILM_TITLES: t, FINISH_QUEUE: queue({ acquire }) });
    expect((await run(e, harness(), [TITLES], false)).complete).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("a capacity refusal yields the slot, and a finished step releases it", async () => {
    quiet();
    const yielded = vi.fn(async () => {});
    const released = vi.fn(async () => {});
    const q = queue({ yield: yielded, release: released });
    const { e } = env({ MODULE_FILM_TITLES: fetcher(TITLES, () => pass("x", CAPACITY)), FINISH_QUEUE: q });
    await run(e, harness(), [TITLES]);
    expect(yielded).toHaveBeenCalledWith("film-1");
    const { e: e2 } = env({ MODULE_FILM_TITLES: fetcher(TITLES, () => ({ film_key: "k", applied: ["film-titles"] })), FINISH_QUEUE: q });
    await run(e2, harness(), [TITLES]);
    expect(released).toHaveBeenCalledWith("film-1");
  });
});

const baseJob = (over: Partial<FilmJob> = {}): FilmJob => ({
  film_id: "film-1", project: "p1", phase: "done", created_at: Date.now() - 1000, scenes: [],
  bundle_key: "b", film_key: "renders/p1/film-ff1.mp4", ...over,
}) as unknown as FilmJob;
const ENTRY = { stage: "film.finish", step: "subtitle", code: "refused", detail: "x", kept: "the film without this step", step_index: 0, at: 1 } as const;

describe("what a reader sees", () => {
  it("a done film with a missing step carries it on the poll and the summary", () => {
    const job = baseJob({ finish_incomplete: [ENTRY] });
    const v = filmJobToPollView(job, null);
    expect(v.status).toBe("COMPLETED");
    expect((v.output as Out).finish_incomplete).toEqual([ENTRY]);
    expect(summarizeFilm(job, null).finish_incomplete).toEqual([ENTRY]);
  });
  it("a clean done has no such key at all", () => {
    expect((filmJobToPollView(baseJob(), null).output as Out).finish_incomplete).toBeUndefined();
    expect(summarizeFilm(baseJob({ finish_incomplete: [] }), null).finish_incomplete).toBeUndefined();
  });
  it("a failed film still names the step and what is kept", () => {
    const e = { ...ENTRY, stage: "assemble", step: "assemble", kept: "the per-shot clips" } as const;
    expect((filmJobToPollView(baseJob({ phase: "failed", finish_incomplete: [e] }), null).output as Out).finish_incomplete).toEqual([e]);
  });
  it("a waiting film shows its position on the poll", () => {
    const now = Date.now();
    const job = baseJob({ phase: "assemble", assemble_wait: encodeAssembleWait({ firstAt: now, attempts: 2, nextAt: now + 1000, detail: "d", queued: true, position: 3, depth: 5, step: "assemble" }) });
    expect((filmJobToPollView(job, null).output as Out).finish_waiting).toMatchObject({ position: 3, depth: 5, queued: true, step: "assemble" });
  });
});

function rowDb() {
  const sql: string[] = [];
  const stmt = (s: string) => ({
    bind: () => stmt(s),
    run: async () => { sql.push(s); return { success: true, meta: { changes: 1 } }; },
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  return { DB: { prepare: (s: string) => stmt(s) }, sql };
}

describe("retryFilmFinish", () => {
  it("film.finish alone: starts from the base cut under new keys, and deletes nothing yet", async () => {
    quiet();
    const job = baseJob({ film_finish_base_key: FILM, finish_incomplete: [{ ...ENTRY, step_index: 1 }], film_finish_skipped: { x: ENTRY } as never, clip_job_id: "c" });
    const db = rowDb();
    const { e, stored, deleted } = env(
      { MODULE_A: fetcher(TITLES, () => ({})), MODULE_B: fetcher(SUBTITLE, () => ({})), DB: db.DB },
      { [filmJobDocKey("film-1")]: JSON.stringify(job), "renders/p1/film-ff0.mp4": "a", "renders/p1/film-ff1.mp4": "c" },
    );
    const r = await retryFilmFinish(e, "film-1");
    expect(r?.retried).toHaveLength(1);
    const after = JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob;
    expect(after).toMatchObject({ phase: "mux", film_key: FILM, film_finish_resume: true, finish_retry_gen: 1 });
    expect(after.finish_incomplete).toBeUndefined();
    expect(after.film_finish_skipped).toEqual({});
    expect(deleted).toEqual([]);
    expect(JSON.parse(after.finish_retry_prior!)).toMatchObject({ phase: "done", film_key: "renders/p1/film-ff1.mp4" });
    expect(db.sql.some((q) => q.includes("status = 'IN_PROGRESS'"))).toBe(true);
  });

  it("a retried step writes a new key, and the delivered film is deleted only once the new one exists", async () => {
    quiet();
    const delivered = "renders/p1/film-ff0.mp4";
    const job = baseJob({ film_key: delivered, film_finish_base_key: FILM, finish_incomplete: [{ ...ENTRY, step: "film-titles", step_index: 0 }], film_titles: { title: { text: "T" } } });
    const db = rowDb();
    const titlesMod = fetcher(TITLES, () => ({ film_key: "renders/p1/film-r1-ff0.mp4", applied: ["film-titles"] }));
    const { e, stored, deleted } = env(
      { MODULE_FILM_TITLES: titlesMod, DB: db.DB },
      { [filmJobDocKey("film-1")]: JSON.stringify(job), [delivered]: "old", [FILM]: "cut", "renders/p1/film-r1-ff0.mp4": "new" },
    );
    await retryFilmFinish(e, "film-1");
    expect(deleted).toEqual([]);
    delete stored["renders/p1/film-r1-ff0.mp4"]; // not there until the step writes it
    const original = titlesMod.fetch;
    titlesMod.fetch = async (input) => { stored["renders/p1/film-r1-ff0.mp4"] = "new"; return original(input); };
    const r = await advanceFilmJob(e, "film-1", [TITLES]);
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_key).toBe("renders/p1/film-r1-ff0.mp4");
    expect(r?.job.finish_retry_prior).toBeUndefined();
    expect(deleted).toContain(delivered);
    expect(deleted).not.toContain(FILM);
  });

  it("the door still down: the film stays delivered, flagged and retryable, and nothing is deleted", async () => {
    quiet();
    const U = mod("finish-upscale", "MODULE_U", "finish");
    const delivered = "renders/p1/film-ff0.mp4";
    const entry = { stage: "finish", step: "MODULE_U", shot_id: "s1", code: "unreachable", kept: "the clip without this step", at: 1 } as const;
    const job = baseJob({
      film_key: delivered, film_finish_base_key: FILM, mux_output_key: "renders/p1/old-audio.mp4",
      film_output_seconds: { [delivered]: 12 },
      finish_shots: [{ shot_id: "s1", clip_key: "renders/p1/clips/s1.mp4", chain: ["MODULE_U"], configs: [{}], idx: 1, status: "done", applied: [] }] as never,
      finish_incomplete: [entry],
    });
    const db = rowDb();
    const door = fetcher(U, () => ({ error: "module unreachable" }));
    const { e, stored, deleted } = env({ MODULE_U: door, DB: db.DB }, { [filmJobDocKey("film-1")]: JSON.stringify(job), [delivered]: "the film" });
    await retryFilmFinish(e, "film-1");
    const start = Date.now();
    let last: FilmJob | undefined;
    for (let i = 1; i <= 16; i++) {
      const clock = vi.spyOn(Date, "now").mockReturnValue(start + i * 16 * 60 * 1000);
      last = (await advanceFilmJob(e, "film-1", [U]))?.job;
      clock.mockRestore();
      if (last?.phase === "done") break;
    }
    expect(door.calls.invoke).toBeGreaterThan(0);
    expect(last).toMatchObject({ phase: "done", film_key: delivered, mux_output_key: "renders/p1/old-audio.mp4" });
    expect(last?.finish_incomplete?.[0]).toMatchObject({ step: "MODULE_U", shot_id: "s1" });
    expect(last?.finish_retry_failed?.reason).toBeTruthy();
    expect(last?.finish_retry_prior).toBeUndefined();
    expect(deleted).not.toContain(delivered);
    expect(deleted).not.toContain("renders/p1/old-audio.mp4");
    expect(stored[delivered]).toBe("the film");
    // The row goes back to COMPLETED, and the user can try again.
    expect(db.sql.some((q) => q.includes("status = 'COMPLETED'"))).toBe(true);
    expect(db.sql.some((q) => q.includes("notified_at = COALESCE(notified_at"))).toBe(true); // not announced again
    expect((await retryFilmFinish(e, "film-1"))?.retried).toHaveLength(1);
  });

  it("a retry that finishes but still misses a step does not replace the film", async () => {
    quiet();
    const delivered = "renders/p1/film-ff0.mp4";
    const job = baseJob({ film_key: delivered, film_finish_base_key: FILM, finish_incomplete: [{ ...ENTRY, step: "film-titles", step_index: 0 }], film_titles: { title: { text: "T" } } });
    const { e, deleted } = env(
      { MODULE_FILM_TITLES: fetcher(TITLES, () => pass("refused", REFUSED)), DB: rowDb().DB },
      { [filmJobDocKey("film-1")]: JSON.stringify(job), [delivered]: "old", [FILM]: "cut" },
    );
    await retryFilmFinish(e, "film-1");
    const r = await advanceFilmJob(e, "film-1", [TITLES]);
    expect(r?.job).toMatchObject({ phase: "done", film_key: delivered });
    expect(r?.job.finish_incomplete).toHaveLength(1);
    expect(deleted).not.toContain(delivered);
  });

  describe("a retry that assembles again", () => {
    const CUT = "renders/film-1/film.mp4";
    const NEW = "renders/film-1/film-r1.mp4";
    const job = () => baseJob({
      film_key: CUT, silent_film_key: CUT, film_finish_base_key: CUT, actual_clip_durations: { s1: 4 },
      scenes: [{ shot_id: "s1", prompt: "p", seconds: 4 }] as never,
      finish_shots: [{ shot_id: "s1", clip_key: "renders/p1/clips/s1.mp4", chain: ["MODULE_U"], configs: [{}], idx: 1, status: "done", applied: [] }] as never,
      finish_incomplete: [{ stage: "assemble", step: "assemble", code: "unavailable", kept: "the per-shot clips", at: 1 }],
    });
    const door = (status: Record<string, unknown>, stored: () => Record<string, string>) => {
      const bodies: { outputKey?: string }[] = [];
      return {
        bodies,
        fetch: async (url: string, init: RequestInit = {}) => {
          if (new URL(url).pathname === "/async/finish") {
            bodies.push(JSON.parse(String(init.body)));
            return Response.json({ ok: true, jobId: "j" }, { status: 202 });
          }
          if (status.status === "completed") stored()[NEW] = "the new cut";
          return Response.json(status);
        },
      };
    };
    const run = async (status: Record<string, unknown>) => {
      let box: Record<string, string> = {};
      const d = door(status, () => box);
      const made = env(
        { DB: rowDb().DB, MEDIA_FINISH_TOKEN: "t", VIDEO_FINISH_URL: "http://vf", MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: d } },
        { [filmJobDocKey("film-1")]: JSON.stringify(job()), [CUT]: "the delivered film" },
      );
      box = made.stored;
      await retryFilmFinish(made.e, "film-1");
      const r = await advanceFilmJob(made.e, "film-1", []);
      return { ...made, d, r };
    };

    it("writes its own key, and a concat that fails leaves the delivered film as it was", async () => {
      quiet();
      const { d, r, stored, deleted } = await run({ status: "failed", error: "ffmpeg exploded" });
      expect(d.bodies[0].outputKey).toBe(NEW);
      expect(r?.job).toMatchObject({ phase: "done", film_key: CUT, silent_film_key: CUT, actual_clip_durations: { s1: 4 } });
      expect(r?.job.finish_retry_failed?.reason).toContain("ffmpeg exploded");
      expect(stored[CUT]).toBe("the delivered film");
      expect(deleted).not.toContain(CUT);
    });

    it("when it is whole the new key is the film, and only then does the old one go", async () => {
      quiet();
      const { d, r, deleted } = await run({ status: "completed", result: { ok: true, durationSeconds: 8 } });
      expect(d.bodies[0].outputKey).toBe(NEW);
      expect(r?.job).toMatchObject({ phase: "done", film_key: NEW, silent_film_key: NEW });
      expect(deleted).toContain(CUT);
      expect(summarizeFilm(r!.job, null).assemble_ms).toBe(8000);
    });
  });

  it("a whole retry also deletes the old cut, when the film delivered was built on it", async () => {
    quiet();
    const CUT = "renders/film-1/film.mp4";
    const NEW = "renders/film-1/film-r1.mp4";
    const delivered = "renders/film-1/film-ff0.mp4";
    const job = baseJob({
      film_key: delivered, silent_film_key: CUT, film_finish_base_key: CUT, actual_clip_durations: { s1: 4 },
      scenes: [{ shot_id: "s1", prompt: "p", seconds: 4 }] as never,
      finish_shots: [{ shot_id: "s1", clip_key: "renders/p1/clips/s1.mp4", chain: ["MODULE_U"], configs: [{}], idx: 1, status: "done", applied: [] }] as never,
      finish_incomplete: [{ stage: "assemble", step: "assemble", code: "unavailable", kept: "k", at: 1 }],
    });
    let box: Record<string, string> = {};
    const door = { fetch: async (url: string) => {
      if (new URL(url).pathname === "/async/finish") return Response.json({ ok: true, jobId: "j" }, { status: 202 });
      box[NEW] = "new";
      return Response.json({ status: "completed", result: { ok: true, durationSeconds: 8 } });
    } };
    const made = env(
      { DB: rowDb().DB, MEDIA_FINISH_TOKEN: "t", VIDEO_FINISH_URL: "http://vf", MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door } },
      { [filmJobDocKey("film-1")]: JSON.stringify(job), [CUT]: "old cut", [delivered]: "old film" },
    );
    box = made.stored;
    await retryFilmFinish(made.e, "film-1");
    const r = await advanceFilmJob(made.e, "film-1", []);
    expect(r?.job.film_key).toBe(NEW);
    expect(made.deleted).toEqual(expect.arrayContaining([CUT, delivered]));
  });

  it("a failed retry that reused the cut does not delete it, because the restored film still names it", async () => {
    quiet();
    const CUT = "renders/film-1/film.mp4";
    const delivered = "renders/film-1/film-audio.mp4";
    const job = baseJob({
      film_key: delivered, silent_film_key: CUT, mux_output_key: delivered, audio_key: "renders/p1/bed.wav", beats_read: true,
      finish_incomplete: [{ stage: "mux", step: "mux", code: "failed", kept: "the silent cut", at: 1 }],
    } as Partial<FilmJob>);
    const door = { fetch: async (url: string) =>
      new URL(url).pathname === "/async/finish"
        ? Response.json({ ok: true, jobId: "j" }, { status: 202 })
        : Response.json({ status: "failed", error: "mux exploded" }) };
    const { e, deleted, stored } = env(
      { DB: rowDb().DB, MEDIA_FINISH_TOKEN: "t", VIDEO_FINISH_URL: "http://vf", MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: door } },
      { [filmJobDocKey("film-1")]: JSON.stringify(job), [CUT]: "cut", [delivered]: "film" },
    );
    await retryFilmFinish(e, "film-1");
    const r = await advanceFilmJob(e, "film-1", []);
    expect(r?.job).toMatchObject({ phase: "done", film_key: delivered, silent_film_key: CUT });
    expect(deleted).not.toContain(CUT);
    expect(deleted).not.toContain(delivered);
    expect(stored[CUT]).toBe("cut");
  });

  it("a film that fails through a throw while retrying is restored, and stays retryable", async () => {
    quiet();
    const delivered = "renders/p1/film-ff0.mp4";
    const job = baseJob({
      film_key: delivered, film_finish_base_key: FILM,
      scenes: [{ shot_id: "s1", prompt: "p", seconds: 4 }] as never,
      finish_shots: [{ shot_id: "s1", clip_key: "renders/p1/clips/s1.mp4", chain: ["MODULE_U"], configs: [{}], idx: 1, status: "done", applied: [] }] as never,
      finish_incomplete: [{ stage: "assemble", step: "assemble", code: "unavailable", kept: "the per-shot clips", at: 1 }],
    });
    const db = rowDb();
    const { e, stored, deleted } = env(
      { DB: db.DB, MEDIA_FINISH_TOKEN: "t", VIDEO_FINISH_URL: "http://vf", MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: { fetch: vi.fn() } } },
      { [filmJobDocKey("film-1")]: JSON.stringify(job), [delivered]: "the film" },
    );
    await retryFilmFinish(e, "film-1");
    (e as unknown as { PRESIGNER: unknown }).PRESIGNER = { presignGet: async () => { throw new Error("presign exploded"); }, presignPut: async () => { throw new Error("presign exploded"); } };
    const r = await advanceFilmJob(e, "film-1", []);
    const after = JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob;
    expect(r?.job.phase).toBe("done");
    expect(after).toMatchObject({ phase: "done", film_key: delivered });
    expect(after.finish_retry_failed?.reason).toContain("presign exploded");
    expect(after.finish_incomplete).toHaveLength(1);
    expect(deleted).not.toContain(delivered);
    expect(db.sql.some((q) => q.includes("status = 'COMPLETED'"))).toBe(true);
    expect((await retryFilmFinish(e, "film-1"))?.retried).toHaveLength(1);
  });

  it("cancelling a retry cancels the retry, not the film", async () => {
    quiet();
    const delivered = "renders/p1/film-ff0.mp4";
    const job = baseJob({ film_key: delivered, film_finish_base_key: FILM, finish_incomplete: [{ ...ENTRY, step_index: 0 }] });
    const { e } = env({ DB: rowDb().DB }, { [filmJobDocKey("film-1")]: JSON.stringify(job), [delivered]: "old" });
    await retryFilmFinish(e, "film-1");
    const r = await cancelFilmJob(e, "film-1");
    expect(r).toMatchObject({ phase: "done", film_key: delivered });
    expect(r?.cancelled).toBeUndefined();
    expect(r?.finish_retry_failed?.reason).toBe("cancelled");
  });

  it("the retried film.finish runs again on the next tick and nothing is muxed", async () => {
    quiet();
    const job = baseJob({ phase: "mux", film_key: FILM, film_finish_resume: true, silent_film_key: "s", audio_key: "a", beats_read: false });
    const t = fetcher(TITLES, () => ({ film_key: "renders/p1/film-ff0.mp4", applied: ["film-titles"] }));
    const door = vi.fn();
    const { e, stored } = env(
      { MODULE_FILM_TITLES: t, VIDEO_FINISH_URL: "http://vf", MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: { fetch: door } } },
      { [filmJobDocKey("film-1")]: JSON.stringify({ ...job, film_titles: { title: { text: "T" } } }), [FILM]: "x", "renders/p1/film-ff0.mp4": "y" },
    );
    const r = await advanceFilmJob(e, "film-1", [TITLES]);
    expect(door).not.toHaveBeenCalled();
    expect(r?.job.film_finish_resume).toBeUndefined();
    expect(stored[filmJobDocKey("film-1")]).toBeTruthy();
  });

  it("while film.finish holds after a mux, the next tick does not submit the mux again", async () => {
    quiet();
    const job = baseJob({ phase: "mux", film_key: "renders/p1/film-audio.mp4", mux_output_key: "renders/p1/film-audio.mp4", silent_film_key: "s", audio_key: "a", beats_read: true });
    const t = fetcher(TITLES, () => pass("x", CAPACITY));
    const door = vi.fn();
    const { e, stored } = env(
      { MODULE_FILM_TITLES: t, MEDIA_FINISH_TOKEN: "t", VIDEO_FINISH_URL: "http://vf", MEDIA_DOOR_FETCHERS: { VIDEO_FINISH_URL: { fetch: door } } },
      { [filmJobDocKey("film-1")]: JSON.stringify({ ...job, film_titles: { title: { text: "T" } } }) },
    );
    const r = await advanceFilmJob(e, "film-1", [TITLES]);
    expect(door).not.toHaveBeenCalled();
    expect(t.calls.invoke).toBe(1);
    expect(r?.job.phase).toBe("mux");
    expect(stored[filmJobDocKey("film-1")]).toContain("assemble_wait");
  });

  it("a per-shot step: reruns only that step on that shot and re-joins the film, and clears the old cut", async () => {
    quiet();
    const shot = (id: string) => ({ shot_id: id, clip_key: `c/${id}.mp4`, chain: ["MODULE_R", "MODULE_U"], configs: [{ a: 1 }, { b: 2 }], idx: 2, status: "done", applied: [] });
    const job = baseJob({
      finish_shots: [shot("s1"), shot("s2")] as never,
      actual_clip_durations: { s1: 4 },
      silent_film_key: "s", mux_output_key: "m", film_finish_base_key: FILM,
      finish_incomplete: [{ stage: "finish", step: "MODULE_U", shot_id: "s2", code: "refused", kept: "the clip without this step", at: 1 }],
      clip_job_id: "c",
    });
    const db = rowDb();
    const { e, stored } = env({ DB: db.DB }, { [filmJobDocKey("film-1")]: JSON.stringify(job) });
    await retryFilmFinish(e, "film-1");
    const after = JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob;
    expect(after.phase).toBe("finish");
    expect(after.finish_shots![0]).toMatchObject({ status: "done", idx: 2 });
    expect(after.finish_shots![1]).toMatchObject({ status: "pending", idx: 0, chain: ["MODULE_U"], configs: [{ b: 2 }], clip_key: "c/s2.mp4" });
    expect(after.actual_clip_durations).toBeUndefined();
    expect(after.film_key).toBeUndefined();
    expect(after.clip_job_id).toBe("c");
  });

  it("never touches a refused shot", async () => {
    quiet();
    const job = baseJob({
      finish_shots: [{ shot_id: "s1", clip_key: "c", chain: ["MODULE_U"], idx: 0, status: "refused", applied: [], error: "csam refusal" }] as never,
      finish_incomplete: [{ stage: "finish", step: "MODULE_U", shot_id: "s1", code: "x", kept: "k", at: 1 }],
    });
    const { e, stored } = env({ DB: rowDb().DB }, { [filmJobDocKey("film-1")]: JSON.stringify(job) });
    await retryFilmFinish(e, "film-1");
    expect((JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob).finish_shots![0].status).toBe("refused");
  });

  it("a clean film has nothing to retry, and is left alone", async () => {
    const { e, stored } = env({}, { [filmJobDocKey("film-1")]: JSON.stringify(baseJob()) });
    const before = stored[filmJobDocKey("film-1")];
    expect((await retryFilmFinish(e, "film-1"))?.retried).toEqual([]);
    expect(stored[filmJobDocKey("film-1")]).toBe(before);
  });

  it("a film in flight cannot be retried", async () => {
    const { e } = env({}, { [filmJobDocKey("film-1")]: JSON.stringify(baseJob({ phase: "mux", finish_incomplete: [ENTRY] })) });
    expect((await retryFilmFinish(e, "film-1"))?.retried).toEqual([]);
  });
});

describe("a film that completes, retries and completes again", () => {
  function row() {
    const d1 = openTestD1();
    d1.raw.prepare("INSERT INTO renders (job_id, status, submitted_at) VALUES ('film-1', 'IN_PROGRESS', 1000)").run();
    const read = () => d1.raw.prepare("SELECT * FROM renders WHERE job_id = 'film-1'").get() as Record<string, unknown>;
    return { d1, read, e: { DB: d1.DB } as unknown as Env };
  }

  it("has one row, bills the last length and never the sum, and keeps when it was asked for", async () => {
    const { d1, read, e } = row();
    try {
      await markFinishDone(e, "film-1", "k1", "{}", 5000, 100);
      expect(read()).toMatchObject({ status: "COMPLETED", output_ms: 5000, finish_elapsed_ms: 100, submitted_at: 1000 });
      await reopenRenderForFinishRetry(e, "film-1");
      expect(read()).toMatchObject({ status: "IN_PROGRESS", output_ms: null, output_key: "k1", completed_at: null, finish_state: null, submitted_at: 1000 });
      await markFinishDone(e, "film-1", "k2", "{}", 8000, 250);
      expect(read()).toMatchObject({ status: "COMPLETED", output_ms: 8000, output_key: "k2", finish_elapsed_ms: 250, submitted_at: 1000 });
      const n = d1.raw.prepare("SELECT COUNT(*) AS n FROM renders").get() as { n: number };
      expect(n.n).toBe(1);
    } finally {
      d1.close();
    }
  });

  it("the reopened row is one the stranded pass can reach", async () => {
    const { d1, read, e } = row();
    try {
      await reopenRenderForFinishRetry(e, "film-1");
      expect(String(read().output_json)).toContain('"phase":"finish"');
    } finally {
      d1.close();
    }
  });

  it("a retry starts with no lengths, so a stale one cannot reach the billing column", async () => {
    quiet();
    const job = baseJob({
      mux_output_key: "renders/p1/old-audio.mp4", silent_film_key: "renders/p1/film.mp4",
      film_output_seconds: { "renders/p1/old-audio.mp4": 9 },
      finish_incomplete: [{ stage: "mix", step: "mix", code: "refused", kept: "k", at: 1 }],
    });
    const { e, stored, deleted } = env({ DB: rowDb().DB }, { [filmJobDocKey("film-1")]: JSON.stringify(job) });
    await retryFilmFinish(e, "film-1");
    expect(deleted).toEqual([]);
    expect((JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob).film_output_seconds).toEqual({});
  });
});

describe("a hold against the stall ceiling", () => {
  const MIN = 60 * 1000;
  const U = { ...mod("finish-upscale", "MODULE_U", "finish"), max_invocation_seconds: 1800 } as RegisteredModule;
  const shot = (): HoldableStep & Record<string, unknown> => ({ shot_id: "s1", clip_key: "c", chain: ["MODULE_U"], configs: [{}], idx: 0, status: "pending", applied: [] });

  it("a step accepted at minute 59 of a hold, after time already pending, can run past minute 90", () => {
    const fs = shot();
    const job = baseJob({ phase: "finish", finish_shots: [fs] as never, phase_started_at: 0, last_progress_at: 0 });
    stampFilmProgress(job, null, 0);
    // 40 minutes pending, and then a capacity refusal starts a hold.
    const t0 = 40 * MIN;
    expect(holdStep(fs, job, "no capacity", FINISH_STEP_HOLD_MAX_SECONDS, t0)).toBe(true);
    for (let m = 1; m <= 59; m++) {
      expect(holdStep(fs, job, "no capacity", FINISH_STEP_HOLD_MAX_SECONDS, t0 + m * MIN)).toBe(true);
      expect(phaseCeilingVerdict(job, [U], t0 + m * MIN).expired).toBe(false);
    }
    // Accepted at minute 59, and it runs well past the 31 minutes the old clock left it.
    const accepted = t0 + 59 * MIN;
    acceptHeldStep(fs, job, accepted);
    expect(fs.wait).toBeUndefined();
    for (const run of [31, 45, 89]) {
      expect(stampFilmProgress(job, null, accepted + run * MIN)).toBe(false); // no marker moved
      expect(phaseCeilingVerdict(job, [U], accepted + run * MIN).expired).toBe(false);
    }
    // A step that truly never ends still dies: the clock restarted, it did not stop.
    expect(phaseCeilingVerdict(job, [U], accepted + 90 * MIN).expired).toBe(true);
  });

  it("the cycle cap keeps a door that accepts and then fails from re-stamping the clock for ever", () => {
    const fs = shot();
    const job = baseJob({ phase: "finish", finish_shots: [fs] as never });
    let now = 0;
    for (let i = 0; i < FINISH_STEP_MAX_HOLD_CYCLES; i++) {
      expect(holdStep(fs, job, "x", undefined, now)).toBe(true);
      now += MIN;
      acceptHeldStep(fs, job, now);
    }
    const stamped = job.last_progress_at;
    expect(holdStep(fs, job, "x", undefined, now + MIN)).toBe(false);
    expect(job.last_progress_at).toBe(stamped);
  });

  it("a poll failure after a long hold gets its own bound, because accepting cleared the wait", () => {
    const fs = shot();
    const job = baseJob({ phase: "finish", finish_shots: [fs] as never });
    expect(holdStep(fs, job, "x", FINISH_STEP_HOLD_MAX_SECONDS, 0)).toBe(true);
    acceptHeldStep(fs, job, 59 * MIN);
    expect(holdStep(fs, job, "poll failed", undefined, 60 * MIN)).toBe(true);
  });

  it("in master, accepting after a hold moves the phase clock, so the 15 minute stall check does not kill the run", async () => {
    quiet();
    const M = mod("audio-master", "MODULE_M", "master");
    const before = Date.now() - 40 * MIN;
    const job = baseJob({
      phase: "master", film_key: undefined, silent_film_key: "s", audio_key: "renders/p1/bed.wav", beats_read: true,
      phase_started_at: before,
      master: { chain: ["MODULE_M"], idx: 0, applied: [], degraded: [], configs: [{}], wait: { firstAt: before, attempts: 3, nextAt: before, detail: "d" }, hold_cycles: 1 },
    } as Partial<FilmJob>);
    const door = { fetch: async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      return url.endsWith("/module.json") ? Response.json(M) : Response.json({ ok: true, pending: true, poll: "tok" });
    } };
    const { e, stored } = env({ MODULE_M: door }, { [filmJobDocKey("film-1")]: JSON.stringify(job) });
    await advanceFilmJob(e, "film-1", [M]);
    const first = JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob;
    expect(first.master?.wait).toBeUndefined();
    expect(first.phase_started_at).toBeGreaterThan(before + 39 * MIN);
    // The next tick polls a step still running, and it is not degraded as stalled.
    await advanceFilmJob(e, "film-1", [M]);
    const second = JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob;
    expect(second.master?.degraded).toEqual([]);
  });

  it("a real film stamps the clock when a held step is accepted", async () => {
    quiet();
    const before = Date.now() - 80 * MIN;
    const job = baseJob({
      phase: "finish", film_key: undefined, phase_started_at: before, last_progress_at: before, progress_marker: "finish:0:0",
      finish_shots: [{ ...shot(), clip_key: "renders/p1/clips/s1.mp4", wait: { firstAt: before, attempts: 3, nextAt: before, detail: "d" }, hold_cycles: 1 }] as never,
    });
    const door = { fetch: async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      return url.endsWith("/module.json") ? Response.json(U) : Response.json({ ok: true, pending: true, poll: "tok" });
    } };
    const { e, stored } = env({ MODULE_U: door }, { [filmJobDocKey("film-1")]: JSON.stringify(job) });
    await advanceFilmJob(e, "film-1", [U]);
    const after = JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob;
    expect(after.finish_shots![0].wait).toBeUndefined();
    expect(after.last_progress_at).toBeGreaterThan(before + 79 * MIN);
  });
});

describe("per-shot finish", () => {
  const job = () => baseJob({
    phase: "finish",
    film_key: undefined,
    finish_shots: [{ shot_id: "s1", clip_key: "renders/p1/clips/s1.mp4", chain: ["MODULE_U"], configs: [{}], idx: 0, status: "pending", applied: [] }] as never,
  });
  const U = mod("finish-upscale", "MODULE_U", "finish");
  const output = (extra: Out): Out => ({ shot_id: "s1", clip_key: "renders/p1/clips/s1.mp4", out_fps: 24, frames: 1, applied: ["passthrough:x"], degraded: "x", ...extra });

  it("a transient failure stays pending, with a wait, and does not move on", async () => {
    quiet();
    const { e, stored } = env({ MODULE_U: fetcher(U, () => output({ failure: UNREACHABLE })) }, { [filmJobDocKey("film-1")]: JSON.stringify(job()) });
    await advanceFilmJob(e, "film-1", [U]);
    const s = (JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob).finish_shots![0];
    expect(s.status).toBe("pending");
    expect(s.idx).toBe(0);
    expect(s.wait).toBeTruthy();
  });

  it("a held shot is not called again inside its wait", async () => {
    quiet();
    const m = fetcher(U, () => output({ failure: UNREACHABLE }));
    const { e } = env({ MODULE_U: m }, { [filmJobDocKey("film-1")]: JSON.stringify(job()) });
    await advanceFilmJob(e, "film-1", [U]);
    await advanceFilmJob(e, "film-1", [U]);
    expect(m.calls.invoke).toBe(1);
  });

  it("a permanent one is named, and the shot goes on", async () => {
    quiet();
    const { e, stored } = env({ MODULE_U: fetcher(U, () => output({ failure: REFUSED })) }, { [filmJobDocKey("film-1")]: JSON.stringify(job()) });
    await advanceFilmJob(e, "film-1", [U]);
    const after = JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob;
    expect(after.finish_incomplete?.[0]).toMatchObject({ stage: "finish", step: "MODULE_U", shot_id: "s1", code: "refused" });
  });

  it("a CSAM refusal is never held and never listed as retryable, whatever else the output says", async () => {
    quiet();
    const { e, stored } = env(
      { MODULE_U: fetcher(U, () => output({ degraded: "csam detected", failure: UNREACHABLE })) },
      { [filmJobDocKey("film-1")]: JSON.stringify(job()) },
    );
    await advanceFilmJob(e, "film-1", [U]);
    const after = JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob;
    expect(after.finish_shots![0].status).toBe("refused");
    expect(after.finish_incomplete).toBeUndefined();
  });
});

describe("the audio mix", () => {
  const job = () => baseJob({
    phase: "mux", film_key: undefined, silent_film_key: "renders/p1/film.mp4", audio_key: "renders/p1/bed.wav",
    beats_read: true, dialogue_audio: { s1: "a.wav" }, finish_shots: [] as never,
  } as Partial<FilmJob>);
  const mixEnv = (status: number) => {
    const mixCalls = { n: 0 };
    vi.stubGlobal("fetch", async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("mix.test")) { mixCalls.n += 1; return new Response("{}", { status }); }
      return new Response(JSON.stringify({ ok: false }), { status: 400 });
    });
    return { mixCalls, ...env({ MEDIA_FINISH_TOKEN: "t", AUDIO_MIX_URL: "https://mix.test", VIDEO_FINISH_URL: "https://vf.test" }, { [filmJobDocKey("film-1")]: JSON.stringify(job()) }) };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("a 5xx holds the film, with no missing step and no mux, and does not mix again inside the wait", async () => {
    quiet();
    const { e, stored, mixCalls } = mixEnv(503);
    await advanceFilmJob(e, "film-1", []);
    const firstTick = mixCalls.n; // the mix call retries inside one tick; the wait is between ticks
    expect(firstTick).toBeGreaterThan(0);
    await advanceFilmJob(e, "film-1", []);
    const after = JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob;
    expect(after.phase).toBe("mux");
    expect(after.mix_wait).toBeTruthy();
    expect(after.finish_incomplete).toBeUndefined();
    expect(mixCalls.n).toBe(firstTick);
  });

  it("a 4xx names the mix as not done and moves on with the bare bed", async () => {
    quiet();
    const { e, stored } = mixEnv(400);
    await advanceFilmJob(e, "film-1", []);
    const after = JSON.parse(stored[filmJobDocKey("film-1")]) as FilmJob;
    expect(after.finish_incomplete?.[0]).toMatchObject({ stage: "mix", code: "refused" });
    expect(after.mix_skipped).toBe(true);
  });
});

describe("the sweep and the queue", () => {
  const sweepDb = () => {
    const stmt = () => ({ bind: () => stmt(), first: async () => ({ n: 0, c: 0 }), run: async () => ({ success: true, meta: { changes: 1 } }), all: async () => ({ results: [] }) });
    return { prepare: () => stmt() };
  };

  it("drives the queue heads with no page reaching them, and forgets a head whose job is gone", async () => {
    quiet();
    const forgotten: string[] = [];
    const q = { acquire: async () => ({}), holders: async () => [], next: async () => ["film-gone"], forget: async (h: string) => { forgotten.push(h); } };
    const { e } = env({ DB: sweepDb(), FINISH_QUEUE: q });
    await sweepUnresolvedJobs(e);
    expect(forgotten).toEqual(["film-gone"]);
  });

  it("drives holders before waiters, so a slot a job gave up is granted in the same tick", async () => {
    quiet();
    const order: string[] = [];
    const q = {
      acquire: async () => ({}),
      holders: async () => { order.push("holders"); return ["film-held"]; },
      next: async () => { order.push("next"); return []; },
      forget: async (h: string) => { order.push(`forget ${h}`); },
    };
    const { e } = env({ DB: sweepDb(), FINISH_QUEUE: q });
    await sweepUnresolvedJobs(e);
    expect(order).toEqual(["holders", "forget film-held", "next"]);
  });

  it("a queue that throws does not stop the sweep", async () => {
    quiet();
    const q = { acquire: async () => ({}), holders: async () => [], next: async () => { throw new Error("no such table"); } };
    const { e } = env({ DB: sweepDb(), FINISH_QUEUE: q });
    await expect(sweepUnresolvedJobs(e)).resolves.toBe(0);
  });
});
