import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILM_ADVANCE_LEASE_RENEW_SECONDS,
  FILM_ADVANCE_LEASE_TTL_SECONDS,
  claimFilmAdvance,
  claimRenderNotify,
  countUnresolvedNotifiableJobs,
  listUnresolvedNotifiableJobs,
  renewFilmAdvance,
} from "../src/renders-db.js";
import { advanceFilmJob, filmJobDocKey, retryFilmFinish, type FilmJob } from "../src/film-orchestrator.js";
import { SWEEP_MAX_AGE_SECONDS } from "../src/render-sweep.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import { openTestD1, type TestD1 } from "./helpers/d1-sqlite.js";

// vivijure-cf#1139. A film tick holds the advance lease and releases it in `finally`. A Worker's
// execution context ends when its client disconnects, and the tick's pending awaits are dropped with
// it, `finally` included. With a 300 s lease that held the film for five minutes per cut-off poll.
//
// These tests use the REAL schema (the cf migrations) for the lease row, and model the host dropping
// a tick the way the runtime does: the tick's promise never settles and its timers are cleared.

const FILM = "film-cf1139-lease";
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);

let d1: TestD1;

function seedRow(jobId: string, mode: string, status = "IN_PROGRESS"): void {
  d1.raw
    .prepare(
      `INSERT INTO renders (job_id, status, submitted_at, output_json, notified_at, mode, parent_id)
       VALUES (?, ?, ?, NULL, NULL, ?, NULL)`,
    )
    .run(jobId, status, Math.floor(Date.now() / 1000) - 60, mode);
}

function leaseRow(jobId: string): { advance_lease: number | null; advance_lease_token: string | null } {
  return d1.raw
    .prepare("SELECT advance_lease, advance_lease_token FROM renders WHERE job_id = ?")
    .get(jobId) as { advance_lease: number | null; advance_lease_token: string | null };
}

const doneFilm = (): FilmJob => ({
  film_id: FILM, project: "neon", bundle_key: "b",
  scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
  motion_backend: "own-gpu", motion_config: {}, finish_config: {},
  keyframe_binding: null, phase: "done", clips_only: true,
  created_at: T0,
});

/** An env whose film doc read never returns on the first call: the tick is parked mid-flight, holding
 *  the lease, exactly as a tick waiting on a slow module is. Later reads answer at once. */
function parkedEnv(): Env {
  let gets = 0;
  const doc = JSON.stringify(doneFilm());
  return {
    DB: d1.DB,
    R2_RENDERS: {
      get: (k: string) => {
        gets += 1;
        if (gets === 1) return new Promise(() => {});
        return Promise.resolve(k === filmJobDocKey(FILM) ? { text: async () => doc } : null);
      },
      put: async () => {},
      list: async () => ({ objects: [], truncated: false }),
      head: async () => null,
    },
  } as unknown as Env;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  d1 = openTestD1();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  d1.close();
});

describe("vivijure-cf#1139: the advance lease lives only as long as its tick", () => {
  it("CONTROL: a parked tick holds the film, so a second driver loses", async () => {
    seedRow(FILM, "keyframes-only");
    const env = parkedEnv();
    void advanceFilmJob(env, FILM);
    await flush();
    expect(leaseRow(FILM).advance_lease_token).not.toBeNull();
    expect((await claimFilmAdvance(env, FILM)).won).toBe(false);
  });

  it("a tick its host drops frees the film within one TTL, not five minutes", async () => {
    seedRow(FILM, "keyframes-only");
    const env = parkedEnv();
    void advanceFilmJob(env, FILM);
    await flush();
    expect(leaseRow(FILM).advance_lease_token).not.toBeNull();
    // The client disconnects: the runtime ends the context. Its timers die and `finally` never runs.
    vi.clearAllTimers();
    vi.setSystemTime(T0 + 61_000);
    // THE assertion. With the old 300 s lease this driver lost for another four minutes.
    expect((await claimFilmAdvance(env, FILM)).won).toBe(true);
  });

  it("a live tick that runs past one TTL keeps the film (renewal), so two drivers never overlap", async () => {
    seedRow(FILM, "keyframes-only");
    const env = parkedEnv();
    void advanceFilmJob(env, FILM);
    await flush();
    const first = leaseRow(FILM).advance_lease as number;
    await vi.advanceTimersByTimeAsync(FILM_ADVANCE_LEASE_TTL_SECONDS * 1000 * 3);
    await flush();
    expect(leaseRow(FILM).advance_lease as number).toBeGreaterThan(first);
    expect((await claimFilmAdvance(env, FILM)).won).toBe(false);
  });

  it("a finish retry renews the same way", async () => {
    seedRow(FILM, "full");
    const env = parkedEnv();
    void retryFilmFinish(env, FILM);
    await flush();
    expect(leaseRow(FILM).advance_lease_token).not.toBeNull();
    await vi.advanceTimersByTimeAsync(FILM_ADVANCE_LEASE_TTL_SECONDS * 1000 * 3);
    await flush();
    expect((await claimFilmAdvance(env, FILM)).won).toBe(false);
  });

  it("a finished tick releases the film and leaves no renewal timer behind", async () => {
    seedRow(FILM, "keyframes-only");
    const doc = JSON.stringify(doneFilm());
    const env = {
      DB: d1.DB,
      R2_RENDERS: {
        get: async (k: string) => (k === filmJobDocKey(FILM) ? { text: async () => doc } : null),
        put: async () => {},
        list: async () => ({ objects: [], truncated: false }),
        head: async () => null,
      },
    } as unknown as Env;
    const r = await advanceFilmJob(env, FILM);
    expect(r?.job.phase).toBe("done");
    expect(leaseRow(FILM).advance_lease_token).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renewal is keyed on the holder's token: a stale token extends nothing", async () => {
    seedRow(FILM, "full");
    const env = { DB: d1.DB } as unknown as Env;
    const claim = await claimFilmAdvance(env, FILM, T0);
    expect(claim.won).toBe(true);
    expect(await renewFilmAdvance(env, FILM, "not-the-holder", T0 + 30_000)).toBe(false);
    expect(leaseRow(FILM).advance_lease).toBe(claim.lease);
    expect(await renewFilmAdvance(env, FILM, claim.token as string, T0 + 30_000)).toBe(true);
    expect(leaseRow(FILM).advance_lease).toBe(T0 + 30_000 + FILM_ADVANCE_LEASE_TTL_SECONDS * 1000);
  });

  it("the renewal period fits at least twice in one TTL", () => {
    expect(FILM_ADVANCE_LEASE_RENEW_SECONDS * 2).toBeLessThan(FILM_ADVANCE_LEASE_TTL_SECONDS);
  });
});

describe("vivijure-cf#1139: the sweep drives a keyframes-only film nobody polls", () => {
  it("pass 1 lists and counts a live keyframes-only film", async () => {
    vi.useRealTimers();
    seedRow("film-cf1139-kf", "keyframes-only");
    seedRow("film-cf1139-full", "full");
    const env = { DB: d1.DB } as unknown as Env;
    const ids = await listUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS);
    expect(ids).toContain("film-cf1139-full"); // control: the query reaches the table
    expect(ids).toContain("film-cf1139-kf");
    expect(await countUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS)).toBe(2);
  });

  it("a finished keyframes-only film still sends no email", async () => {
    vi.useRealTimers();
    seedRow("film-cf1139-kf-done", "keyframes-only", "COMPLETED");
    seedRow("film-cf1139-full-done", "full", "COMPLETED");
    const env = { DB: d1.DB } as unknown as Env;
    expect(await claimRenderNotify(env, "film-cf1139-full-done")).not.toBeNull(); // control
    expect(await claimRenderNotify(env, "film-cf1139-kf-done")).toBeNull();
  });
});
