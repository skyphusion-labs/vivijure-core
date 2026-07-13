import { describe, it, expect } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// #24/#697: the R2 assemble self-heal shortcut (#122) must NOT finalize an assembled concat that was
// never duration-gated. The shortcut fires in exactly the race the #697 per-shot duration gate exists
// to catch (a prior attempt's ffmpeg PUT landed the concat but its response -- carrying the per-clip
// clipDurations -- was lost), so blindly finalizing from the present object ships a truncated shot as a
// silent green. The fix gates the shortcut on a PRIOR gated pass (actual_clip_durations persisted);
// absent it, the assemble re-runs (idempotent, bounded) so the gate arms on the fresh clipDurations.

const FILM = "film-selfheal-gate";
const OUT = `renders/${FILM}/film.mp4`; // == filmOutKey(FILM)
const CLIP = `renders/${FILM}/shots/shot_01.mp4`;

function assembleEnv(job: object) {
  const filmId = (job as { film_id: string }).film_id;
  let stored = JSON.stringify(job);
  let finishCalls = 0;
  const jsonResp = (b: unknown) =>
    new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      // the film-job doc AND the concat output both "exist": head(OUT) != null trips the self-heal path.
      get: async (key: string) => (key === filmJobDocKey(filmId) ? { text: async () => stored } : null),
      head: async (key: string) => (key === OUT || key === filmJobDocKey(filmId) ? { size: 1 } : null),
      put: async (key: string, val: string) => { if (key === filmJobDocKey(filmId)) stored = val; },
    },
    PRESIGNER: {
      presignGet: async (key: string) => `https://presigned/${key}`,
      presignPut: async (key: string) => `https://presigned-put/${key}`,
    },
    VIDEO_FINISH_VPC: {
      fetch: async (url: string) => {
        if (typeof url === "string" && url.includes("/finish")) {
          finishCalls++;
          // a fresh gated concat: one 4.0s shot, matching the plan -> gate passes.
          return jsonResp({ ok: true, key: OUT, durationSeconds: 4, shots: 1, clipDurations: [4.0] });
        }
        return jsonResp({ ok: true });
      },
    },
  };
  return { env: env as unknown as Env, read: () => JSON.parse(stored) as FilmJob, finishCalls: () => finishCalls };
}

const assembleJob = (over: object = {}) => ({
  film_id: FILM,
  project: "p",
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
  phase: "assemble" as const,
  finish_shots: [{ shot_id: "shot_01", clip_key: CLIP, status: "done" }],
  created_at: 0,
  ...over,
});

describe("assemble self-heal shortcut honors the #697 duration gate (#24)", () => {
  it("concat present but NO prior gated pass -> re-assembles (gate arms), never a blind finalize", async () => {
    const { env, finishCalls } = assembleEnv(assembleJob()); // actual_clip_durations UNSET
    const r = await advanceFilmJob(env, FILM);
    // the shortcut was declined: the container was re-called, so the fresh clipDurations gate the concat.
    expect(finishCalls()).toBeGreaterThanOrEqual(1);
    expect(r?.job.phase).toBe("done");
    expect(r?.job.actual_clip_durations).toBeTruthy();
  });

  it("concat present AND a prior gated pass (actual_clip_durations set) -> shortcut, no re-assemble", async () => {
    const { env, finishCalls } = assembleEnv(assembleJob({ actual_clip_durations: { shot_01: 4.0 } }));
    const r = await advanceFilmJob(env, FILM);
    // durations already validated: finalize straight from R2, container NOT re-called (the #122 saving).
    expect(finishCalls()).toBe(0);
    expect(r?.job.phase).toBe("done");
  });
});
