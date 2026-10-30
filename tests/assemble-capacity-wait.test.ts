import { afterEach, describe, expect, it, vi } from "vitest";
import { installVfFetch } from "./install-vf-fetch.js";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { summarizeFilm } from "../src/film-model.js";
import { advanceScatterJob } from "../src/scatter-orchestrator.js";
import {
  ASSEMBLE_CAPACITY_BACKOFF_BASE_SECONDS,
  ASSEMBLE_CAPACITY_MAX_WAIT_SECONDS,
  FINISH_AFFINITY_HEADER,
  assembleCapacityBackoffSeconds,
  decodeAssembleWait,
  encodeAssembleWait,
  tickVideoFinishAssemble,
} from "../src/video-finish-assemble.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// A finish door with no free instance is a wait. It is not a failed film.
// Six films with paid clips failed on this path, each with a bare "returned 500".

const FILM = "film-capacity";
const CLIP = `renders/${FILM}/shots/shot_01.mp4`;
const payload = { clips: [{ url: "https://r2/c.mp4" }], outputUrl: "https://r2/o.mp4", outputKey: "renders/x/film.mp4" };
const CAPACITY = JSON.stringify({ ok: false, error: "capacity_exhausted", detail: "Maximum number of running container instances exceeded" });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function tickEnv(handler: (path: string, init: RequestInit) => Response) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const env = {
    MEDIA_FINISH_TOKEN: "t",
    VIDEO_FINISH_URL: "http://video-finish",
    MEDIA_DOOR_FETCHERS: {
      VIDEO_FINISH_URL: {
        fetch: async (url: string, init: RequestInit = {}) => {
          const path = new URL(url).pathname;
          calls.push({ path, init });
          return handler(path, init);
        },
      },
    },
  } as unknown as Env;
  return { env, calls };
}

describe("tickVideoFinishAssemble at capacity", () => {
  it("returns waiting on a 429, with the door's words and a backoff", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = tickEnv(() => new Response(CAPACITY, { status: 429 }));
    const tick = await tickVideoFinishAssemble(env, payload, undefined);
    expect(tick.kind).toBe("waiting");
    if (tick.kind !== "waiting") return;
    expect(tick.detail).toContain("Maximum number of running container instances");
    const wait = decodeAssembleWait(tick.wait)!;
    expect(wait.attempts).toBe(1);
    expect(wait.nextAt - wait.firstAt).toBe(ASSEMBLE_CAPACITY_BACKOFF_BASE_SECONDS * 1000);
  });

  it("does not touch the door inside the backoff window", async () => {
    const { env, calls } = tickEnv(() => new Response(CAPACITY, { status: 429 }));
    const now = Date.now();
    const wait = encodeAssembleWait({ firstAt: now, attempts: 1, nextAt: now + 60_000, detail: "d" });
    const tick = await tickVideoFinishAssemble(env, payload, undefined, { wait });
    expect(tick.kind).toBe("waiting");
    expect(calls).toHaveLength(0);
  });

  it("keeps the first timestamp across attempts, so the bound is not reset", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = tickEnv(() => new Response(CAPACITY, { status: 429 }));
    const firstAt = Date.now() - 600_000;
    const wait = encodeAssembleWait({ firstAt, attempts: 4, nextAt: Date.now() - 1, detail: "d" });
    const tick = await tickVideoFinishAssemble(env, payload, undefined, { wait });
    if (tick.kind !== "waiting") throw new Error(`expected waiting, got ${tick.kind}`);
    const next = decodeAssembleWait(tick.wait)!;
    expect(next.firstAt).toBe(firstAt);
    expect(next.attempts).toBe(5);
  });

  it("fails, naming the cause, once the bound has passed", async () => {
    const { env } = tickEnv(() => new Response(CAPACITY, { status: 429 }));
    const firstAt = Date.now() - ASSEMBLE_CAPACITY_MAX_WAIT_SECONDS * 1000;
    const wait = encodeAssembleWait({ firstAt, attempts: 70, nextAt: Date.now() - 1, detail: "d" });
    const tick = await tickVideoFinishAssemble(env, payload, undefined, { wait });
    if (tick.kind !== "failed") throw new Error(`expected failed, got ${tick.kind}`);
    expect(tick.capacity).toBe(true);
    expect(tick.unreachable).toBe(true);
    expect(tick.error).toContain("no free instance");
    expect(tick.error).toContain("Maximum number of running container instances");
  });

  it("submits once a slot frees and reports a job", async () => {
    const { env, calls } = tickEnv((path) =>
      path.startsWith("/async/status")
        ? new Response(JSON.stringify({ status: "pending" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, jobId: "j1" }), { status: 202 }),
    );
    const wait = encodeAssembleWait({ firstAt: Date.now() - 1000, attempts: 1, nextAt: Date.now() - 1, detail: "d" });
    const tick = await tickVideoFinishAssemble(env, payload, undefined, { wait });
    expect(tick.kind).toBe("pending");
    expect(calls[0].path).toBe("/async/finish");
  });

  it("sends the film id as the affinity header on a submit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env, calls } = tickEnv(() => new Response(CAPACITY, { status: 429 }));
    await tickVideoFinishAssemble(env, payload, undefined, { affinity: FILM });
    expect((calls[0].init.headers as Record<string, string>)[FINISH_AFFINITY_HEADER]).toBe(FILM);
  });

  it("backs off 30, 60, 120, 240, then holds at 300 seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 40].map(assembleCapacityBackoffSeconds)).toEqual([30, 60, 120, 240, 300, 300, 300]);
  });
});

describe("a refusal that is not capacity", () => {
  it("stays terminal and names the door's words, not a bare status", async () => {
    const { env } = tickEnv(() => new Response("Failed to start container: boom", { status: 500 }));
    const tick = await tickVideoFinishAssemble(env, payload, undefined);
    if (tick.kind !== "failed") throw new Error(`expected failed, got ${tick.kind}`);
    expect(tick.capacity).toBeUndefined();
    expect(tick.error).toContain("returned 500");
    expect(tick.error).toContain("Failed to start container: boom");
  });

  it("removes a presigned URL from the stored text", async () => {
    const { env } = tickEnv(() => new Response("403 from https://r2/x.mp4?X-Amz-Signature=abc123 while reading", { status: 500 }));
    const tick = await tickVideoFinishAssemble(env, payload, undefined);
    if (tick.kind !== "failed") throw new Error(`expected failed, got ${tick.kind}`);
    expect(tick.error).not.toContain("abc123");
    expect(tick.error).toContain("<url>");
  });
});

function filmEnv(job: object, handler: (path: string) => Response) {
  let stored = JSON.stringify(job);
  const deletes: string[] = [];
  const calls: string[] = [];
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string) => (key === filmJobDocKey(FILM) ? { text: async () => stored } : null),
      head: async () => null,
      put: async (key: string, val: string) => { if (key === filmJobDocKey(FILM)) stored = val; },
      delete: async (key: string) => { deletes.push(key); },
    },
    PRESIGNER: {
      presignGet: async (key: string) => `https://presigned/${key}`,
      presignPut: async (key: string) => `https://presigned-put/${key}`,
    },
    VIDEO_FINISH_URL: "https://video-finish.test",
    MEDIA_FINISH_TOKEN: "t",
  };
  installVfFetch(async (input) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(u).pathname;
    calls.push(path);
    return handler(path);
  });
  return { env: env as unknown as Env, read: () => JSON.parse(stored) as FilmJob, deletes, calls };
}

const assembleJob = (over: object = {}) => ({
  film_id: FILM,
  project: "p",
  bundle_key: "bundles/none.tar.gz",
  phase: "assemble",
  created_at: Date.now(),
  scenes: [{ shot_id: "shot_01", prompt: "x" }],
  finish_shots: [{ shot_id: "shot_01", clip_key: CLIP, status: "done", chain: [], idx: 0 }],
  ...over,
});

describe("the film at capacity", () => {
  it("stays in assemble with no error, then a later tick submits", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let full = true;
    const h = filmEnv(assembleJob(), (path) => {
      if (path === "/async/finish") {
        return full
          ? new Response(CAPACITY, { status: 429 })
          : new Response(JSON.stringify({ ok: true, jobId: "j1" }), { status: 202 });
      }
      return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
    });
    await advanceFilmJob(h.env, FILM);
    const held = h.read();
    expect(held.phase).toBe("assemble");
    expect(held.error).toBeUndefined();
    expect(held.assemble_poll).toBeUndefined();
    expect(decodeAssembleWait(held.assemble_wait)?.attempts).toBe(1);
    expect(h.deletes).toEqual([]);

    // Inside the backoff: no door call.
    const before = h.calls.length;
    await advanceFilmJob(h.env, FILM);
    expect(h.calls.length).toBe(before);

    // Past the backoff, with a free slot.
    full = false;
    vi.useFakeTimers({ now: Date.now() + 31_000, toFake: ["Date"] });
    await advanceFilmJob(h.env, FILM);
    const running = h.read();
    expect(running.phase).toBe("assemble");
    expect(running.assemble_wait).toBeUndefined();
    expect(running.assemble_poll).toContain("j1");
  });

  it("past the bound it fails, keeps the clips on the record, and names capacity", async () => {
    const h = filmEnv(
      assembleJob({
        assemble_wait: encodeAssembleWait({
          firstAt: Date.now() - ASSEMBLE_CAPACITY_MAX_WAIT_SECONDS * 1000,
          attempts: 70,
          nextAt: Date.now() - 1,
          detail: "d",
        }),
      }),
      () => new Response(CAPACITY, { status: 429 }),
    );
    await advanceFilmJob(h.env, FILM);
    const job = h.read();
    expect(job.phase).toBe("failed");
    expect(job.error).toContain("no free instance");
    expect(job.error).not.toContain("unreachable");
    expect(job.finish_unavailable?.retained).toBe("clips");
    expect(job.finish_unavailable?.clips?.[0].clip_key).toBe(CLIP);
    expect(h.deletes.some((k) => k === CLIP)).toBe(false);
  });
});

describe("the other legs at capacity", () => {
  it("a waiting film mints no URLs inside the backoff window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = filmEnv(assembleJob(), () => new Response(CAPACITY, { status: 429 }));
    let presigns = 0;
    const presigner = (h.env as unknown as { PRESIGNER: Record<string, (k: string) => Promise<string>> }).PRESIGNER;
    const real = presigner.presignGet;
    presigner.presignGet = async (k) => { presigns++; return real(k); };
    await advanceFilmJob(h.env, FILM);
    const first = presigns;
    expect(first).toBeGreaterThan(0);
    await advanceFilmJob(h.env, FILM);
    expect(presigns).toBe(first);
  });

  it("mux stays in mux and clears the wait when a slot frees", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let full = true;
    const h = filmEnv(
      {
        film_id: FILM,
        project: "p",
        scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
        phase: "mux",
        silent_film_key: `renders/${FILM}/film-silent.mp4`,
        audio_key: `renders/${FILM}/bed.wav`,
        mux_output_key: `renders/${FILM}/film-audio.mp4`,
        beats_read: true,
        created_at: Date.now(),
      },
      (path) => {
        if (path === "/async/finish") {
          return full
            ? new Response(CAPACITY, { status: 429 })
            : new Response(JSON.stringify({ ok: true, jobId: "j2" }), { status: 202 });
        }
        return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
      },
    );
    await advanceFilmJob(h.env, FILM);
    expect(h.read().phase).toBe("mux");
    expect(h.read().error).toBeUndefined();
    expect(decodeAssembleWait(h.read().assemble_wait)?.attempts).toBe(1);
    full = false;
    vi.useFakeTimers({ now: Date.now() + 31_000, toFake: ["Date"] });
    await advanceFilmJob(h.env, FILM);
    expect(h.read().assemble_wait).toBeUndefined();
    expect(h.read().assemble_poll).toContain("j2");
  });

  it("scatter mux stays in mux on the same refusal", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const SID = "scatter-capacity";
    const docKey = `renders/${SID}/scatter-job.json`;
    let stored = JSON.stringify({
      scatter_id: SID,
      project: "p",
      bundle_key: `bundles/${SID}.tar.gz`,
      shard_film_ids: ["shard-a"],
      shard_shots: [["shot_01"]],
      expected_shot_ids: ["shot_01"],
      scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
      phase: "mux",
      silent_film_key: `renders/${SID}/film-silent.mp4`,
      audio_key: `renders/${SID}/bed.wav`,
      created_at: 0,
    });
    const env = {
      DB: { prepare: () => { const st = { bind: () => st, first: async () => null, run: async () => ({ success: true, meta: { changes: 1 } }), all: async () => ({ results: [] }) }; return st; } },
      R2_RENDERS: {
        get: async (k: string) => (k === docKey ? { text: async () => stored } : null),
        head: async () => null,
        put: async (k: string, v: string) => { if (k === docKey) stored = v; },
      },
      PRESIGNER: { presignGet: async (k: string) => `https://p/${k}`, presignPut: async (k: string) => `https://p/${k}` },
      VIDEO_FINISH_URL: "https://video-finish.test",
      MEDIA_FINISH_TOKEN: "t",
    } as unknown as Env;
    installVfFetch(async () => new Response(CAPACITY, { status: 429 }));
    await advanceScatterJob(env, SID);
    const job = JSON.parse(stored) as { phase: string; error?: string; assemble_wait?: string };
    expect(job.phase).toBe("mux");
    expect(job.error).toBeUndefined();
    expect(decodeAssembleWait(job.assemble_wait)?.attempts).toBe(1);
  });

  it("summarizeFilm says the film is waiting, and is silent otherwise", () => {
    const wait = { firstAt: 1, attempts: 2, nextAt: 3, detail: "no slot" };
    const base = assembleJob() as unknown as FilmJob;
    expect(summarizeFilm({ ...base, assemble_wait: encodeAssembleWait(wait) }, null).finish_waiting)
      .toEqual({ since: 1, attempts: 2, next_at: 3, detail: "no slot" });
    expect(summarizeFilm(base, null).finish_waiting).toBeUndefined();
  });
});
