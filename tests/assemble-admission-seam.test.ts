import { describe, it, expect } from "vitest";
import { installVfFetch, vfAsyncFinish } from "./install-vf-fetch.js";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { clipJobDocKey } from "../src/film-model.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// cf#815 at the REAL SEAM, not at the pure function.
//
// The acceptance criterion is that the gate is "demonstrated FIRING", and a pure-function test
// cannot demonstrate that: it proves the decision path and says nothing about whether the shipped
// orchestrator consults it. So these drive `advanceFilmJob` and assert on the ONE thing the
// container's cost actually turns on -- WHETHER A PRESIGNED URL WAS MINTED AT ALL.
//
// PRESIGN COUNT IS THE UN-STUBBABLE SEAM. A refusal that still minted 80 GETs, a PUT and an
// 80-pair partial pool has not saved anything; the container would have been handed everything it
// needed and the "refusal" would be decoration. Zero is the only passing number.

const FILM = "film-cf815";
const OUT = `renders/${FILM}/film.mp4`;
const CLIP_JOB = "clipjob-cf815";

function seamEnv(job: object, clipJob?: object) {
  const filmId = (job as { film_id: string }).film_id;
  let stored = JSON.stringify(job);
  let presignGets = 0;
  let presignPuts = 0;
  let finishCalls = 0;
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string) => {
        if (key === filmJobDocKey(filmId)) return { text: async () => stored };
        if (clipJob && key === clipJobDocKey(CLIP_JOB)) {
          return { text: async () => JSON.stringify(clipJob) };
        }
        return null;
      },
      // OUT absent: no #122 self-heal shortcut, so the run reaches the real assemble path.
      head: async (key: string) => (key === filmJobDocKey(filmId) ? { size: 1 } : null),
      put: async (key: string, val: string) => { if (key === filmJobDocKey(filmId)) stored = val; },
      delete: async () => undefined,
    },
    PRESIGNER: {
      presignGet: async (key: string) => { presignGets++; return `https://presigned/${key}`; },
      presignPut: async (key: string) => { presignPuts++; return `https://presigned-put/${key}`; },
    },
    VIDEO_FINISH_URL: "https://video-finish.test",
    MEDIA_FINISH_TOKEN: "test-tok",
  };
  return {
    env: env as unknown as Env,
    read: () => JSON.parse(stored) as FilmJob,
    presignGets: () => presignGets,
    presignPuts: () => presignPuts,
    finishCalls: () => finishCalls,
    installVf: (result: unknown) => {
      const asyncVf = vfAsyncFinish(result);
      installVfFetch(async (url, init) => {
        if (String(url).includes("/async/finish")) finishCalls++;
        return asyncVf(url, init);
      });
    },
  };
}

/** A film of `n` shots, each planned at `seconds`. */
function film(n: number, seconds: number, over: object = {}) {
  const ids = Array.from({ length: n }, (_unused, i) => `shot_${String(i + 1).padStart(2, "0")}`);
  return {
    film_id: FILM,
    project: "p",
    scenes: ids.map((shot_id) => ({ shot_id, prompt: "x", seconds })),
    phase: "assemble" as const,
    finish_shots: ids.map((shot_id) => ({
      shot_id,
      clip_key: `renders/${FILM}/shots/${shot_id}.mp4`,
      status: "done",
    })),
    created_at: 0,
    ...over,
  };
}

describe("cf#815 the gate FIRES at the seam: nothing is presigned, nothing is submitted", () => {
  it("an over-size film fails terminally having minted ZERO presigned URLs", async () => {
    // 80 shots x 120s = 160 minutes at 1920x1080@24. cf#813's measured ceiling puts that around
    // 13.4 GB of normalized video against a ~6.85 GB finalize budget.
    const h = seamEnv(film(80, 120));
    h.installVf({ ok: true, key: OUT, durationSeconds: 9600, shots: 80 });
    const r = await advanceFilmJob(h.env, FILM);

    expect(r?.job.phase).toBe("failed");
    // THE ASSERTION THE ISSUE IS FOR: refused BEFORE the first presign, so no clip URL, no output
    // PUT and no partial pool were ever minted, and the container was never called.
    expect(h.presignGets()).toBe(0);
    expect(h.presignPuts()).toBe(0);
    expect(h.finishCalls()).toBe(0);
  });

  it("the persisted error carries the arithmetic a caller can act on", async () => {
    const h = seamEnv(film(80, 120));
    h.installVf({ ok: true, key: OUT });
    await advanceFilmJob(h.env, FILM);
    const err = h.read().error ?? "";
    expect(err).toContain("assemble refused before any clip was fetched");
    expect(err).toContain("9600.0s");
    expect(err).toContain("1920x1080@24");
    expect(err).toMatch(/Over by \d+\.\d\d GB/);
    expect(err).toContain("admits at most");
    // Not a degrade: the film is failed, not quietly shipped short.
    expect(h.read().phase).toBe("failed");
  });

  it("MEASURED clip seconds drive the refusal even when the PLAN says the film is small", async () => {
    // The plan says 8s per shot (a ~0.9 GB film, comfortably admitted). The clip doc says each
    // delivered clip is actually 4800 frames at 24 fps = 200s. Measured must win, or a door that
    // over-delivers length walks straight past the gate.
    const ids = Array.from({ length: 80 }, (_unused, i) => `shot_${String(i + 1).padStart(2, "0")}`);
    const clipJob = {
      job_id: CLIP_JOB,
      shots: ids.map((shot_id) => ({
        shot_id, status: "done", seconds: 8, delivered_frames: 4800, delivered_fps: 24,
      })),
    };
    const h = seamEnv(film(80, 8, { clip_job_id: CLIP_JOB }), clipJob);
    h.installVf({ ok: true, key: OUT });
    const r = await advanceFilmJob(h.env, FILM);

    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toContain("16000.0s"); // 80 x 200s measured, not 80 x 8s planned
    expect(r?.job.error).toContain("80 measured, 0 planned, 0 unknown");
    expect(h.presignGets()).toBe(0);
    expect(h.presignPuts()).toBe(0);
  });
});

describe("cf#815 CONTROL at the seam: a legitimate large film still assembles", () => {
  it("MAX_CLIPS clips at 8.0s is admitted, presigned and submitted through to done", async () => {
    // Same code path, same constants, the largest film the clip path can legitimately produce.
    // If this goes red the gate is set to zero and the FIRING test above proves nothing.
    const h = seamEnv(film(80, 8));
    h.installVf({
      ok: true, key: OUT, durationSeconds: 640, shots: 80,
      clipDurations: Array.from({ length: 80 }, () => 8.0),
    });
    const r = await advanceFilmJob(h.env, FILM);

    expect(r?.job.phase).not.toBe("failed");
    expect(r?.job.error).toBeUndefined();
    // 80 clip GETs + 80 partial GETs + 1 output PUT + 80 partial PUTs: the pool was minted, so the
    // admitted path really did run rather than short-circuiting somewhere earlier.
    expect(h.presignGets()).toBeGreaterThanOrEqual(80);
    expect(h.presignPuts()).toBeGreaterThanOrEqual(80);
    expect(h.finishCalls()).toBeGreaterThanOrEqual(1);
  });

  it("a MEASURED short film is admitted even when the PLAN would be refused", async () => {
    // Symmetry with the measured-wins refusal above: measured evidence must be able to RESCUE a
    // film as well as refuse one, or "measured wins" is only half implemented.
    //
    // 80 shots PLANNED at 100s = 8000s, which predicts ~11.2 GB and is refused. The clips actually
    // delivered 1320 frames at 24 fps = 55s each, so the real film is 4400s and predicts ~6.2 GB,
    // which is admitted. 55s also clears the #697 duration gate's floor (50% of the 100s plan), so
    // that separate gate stays out of this assertion -- an earlier draft of this fixture used 8s
    // against a 200s plan and was failed by #697 for a 96% truncation, which is #697 working
    // correctly and says nothing about admission.
    const ids = Array.from({ length: 80 }, (_unused, i) => `shot_${String(i + 1).padStart(2, "0")}`);
    const clipJob = {
      job_id: CLIP_JOB,
      shots: ids.map((shot_id) => ({
        shot_id, status: "done", seconds: 100, delivered_frames: 1320, delivered_fps: 24, // 55s real
      })),
    };
    const h = seamEnv(film(80, 100, { clip_job_id: CLIP_JOB }), clipJob);
    h.installVf({
      ok: true, key: OUT, durationSeconds: 4400, shots: 80,
      clipDurations: Array.from({ length: 80 }, () => 55.0),
    });
    const r = await advanceFilmJob(h.env, FILM);

    expect(r?.job.error ?? "").not.toContain("assemble refused");
    expect(r?.job.phase).not.toBe("failed");
    expect(h.finishCalls()).toBeGreaterThanOrEqual(1);
  });

  it("CONTROL OF THE CONTROL: the same film on its PLAN alone would be refused", async () => {
    // Without this, the test above could pass because the film was small all along rather than
    // because the measurement rescued it. Same 100s plan, no clip doc -> refused.
    const h = seamEnv(film(80, 100));
    h.installVf({ ok: true, key: OUT });
    const r = await advanceFilmJob(h.env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toContain("assemble refused");
    expect(r?.job.error).toContain("8000.0s");
  });
});

describe("cf#815 the gate is on the SUBMITTING pass, so nothing is refused retroactively", () => {
  it("an over-size film already in flight is not failed by the admission check on a poll tick", async () => {
    // `assemble_poll` set == already submitted, which in production can only mean it PASSED the
    // gate (or predates it). Re-refusing here would fail a film whose bytes are already committed
    // and whose presigns are already minted, so the saving the gate exists for is long gone.
    //
    // This deliberately does NOT assert on how many times the clip doc was read.
    // film-orchestrator.ts:202 reads that same object for its own reasons on every pass, so a
    // read-count assertion here would be crediting another caller's I/O to this gate.
    const h = seamEnv(
      film(80, 120, {
        clip_job_id: CLIP_JOB,
        assemble_poll: JSON.stringify({ jobId: "job-test", submittedAt: Date.now(), notFoundStreak: 0 }),
      }),
      { job_id: CLIP_JOB, shots: [] },
    );
    h.installVf({ ok: true, key: OUT, durationSeconds: 9600, shots: 80 });
    const r = await advanceFilmJob(h.env, FILM);

    expect(r?.job.error ?? "").not.toContain("assemble refused");
    // A poll tick mints nothing either way, which is what makes re-gating pointless as well as wrong.
    expect(h.presignGets()).toBe(0);
    expect(h.presignPuts()).toBe(0);
  });
});
