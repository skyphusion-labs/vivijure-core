import { describe, it, expect } from "vitest";
import { installVfFetch } from "./install-vf-fetch.js";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// cf#746(a): a TRANSPORT failure at mux must not ship a silent film as COMPLETED.
//
// Two legs of one pipeline treat the identical `tick.kind === "failed"` in opposite ways, ten lines
// apart in film-orchestrator.ts: assemble sets phase="failed", mux calls degradeMuxUnavailable and
// transitions to DONE with the silent film. So which outcome a user gets depends on where the render
// happened to die, and the mux outcome is terminal: the job reads COMPLETED, and the audio they asked
// for is never coming.
//
// It is not a dead-host-only edge case. submitAsync returns failed on the FIRST attempt with no retry
// (video-finish-assemble.ts:195-197), so a single transient blip at mux permanently converts a
// film-with-audio into a silent film marked COMPLETED.
//
// WHAT STAYS. Two mux degrades are legitimate and must remain green here, because retrying cannot help:
//   * VIDEO_FINISH_URL unset -- the tier is not installed at all (#519, by design).
//   * hasAudio:false -- the container ran and reported the bed unusable (#245/#249/#77,
//     covered by mux-silent-bed-honesty.test.ts, which must stay green alongside this file).
// The distinction this file encodes: DEGRADE when a retry cannot help, FAIL when it can.

const FILM = "film-mux-transport";
const SILENT = `renders/${FILM}/film-silent.mp4`;
const OUT = `renders/${FILM}/film-audio.mp4`;
const CLIP = `renders/${FILM}/shots/shot_01.mp4`;

function envFor(job: object, handler: (u: string) => Promise<Response>) {
  const filmId = (job as { film_id: string }).film_id;
  let stored = JSON.stringify(job);
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string) => (key === filmJobDocKey(filmId) ? { text: async () => stored } : null),
      // cf#833: SILENT really is in R2 on this path -- the last case in this file asserts exactly
      // that in prose -- and the done transition now HEADs the film before stamping it.
      head: async (key: string) =>
        key === filmJobDocKey(filmId) || key === SILENT || key === OUT ? { size: 4096 } : null,
      put: async (key: string, val: string) => { if (key === filmJobDocKey(filmId)) stored = val; },
    },
    PRESIGNER: {
      presignGet: async (key: string) => `https://presigned/${key}`,
      presignPut: async (key: string) => `https://presigned-put/${key}`,
    },
    VIDEO_FINISH_URL: "https://video-finish.test",
    MEDIA_FINISH_TOKEN: "test-tok",
  };
  installVfFetch(async (input) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(u);
  });
  return { env: env as unknown as Env, read: () => JSON.parse(stored) as FilmJob };
}

const json = (b: unknown, status: number) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** The dead-origin case: the fetch itself rejects, exactly as NXDOMAIN does. */
const submitThrows = async (_u: string): Promise<Response> => {
  throw new TypeError("fetch failed");
};

/** Origin answers, but not with the 202 + jobId the submit contract requires. */
const submitNot202 = async (u: string): Promise<Response> => {
  if (u.includes("/async/finish")) return json({ ok: false, error: "bad gateway" }, 502);
  return json({ ok: true, status: "pending" }, 200);
};

/** Submit is accepted, then the container reports the job itself failed. */
const statusFailed = async (u: string): Promise<Response> => {
  if (u.includes("/async/finish")) return json({ ok: true, jobId: "job-x", status: "pending" }, 202);
  if (u.includes("/async/status/")) return json({ ok: true, status: "failed", error: "ffmpeg exploded" }, 200);
  return json({ ok: false }, 404);
};

const muxJob = (over: object = {}) => ({
  film_id: FILM,
  project: "p",
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
  phase: "mux" as const,
  silent_film_key: SILENT,
  audio_key: `renders/${FILM}/bed.wav`,
  mux_output_key: OUT,
  created_at: 0,
  ...over,
});

describe("cf#746(a): a transport failure at mux FAILS, it does not ship a silent film as COMPLETED", () => {
  for (const [name, handler] of [
    ["dead origin (submit throws, the NXDOMAIN shape)", submitThrows],
    ["origin answers non-202 on submit", submitNot202],
    ["container reports the job failed", statusFailed],
  ] as const) {
    it(`${name} -> phase failed, NOT a silent green`, async () => {
      const { env, read } = envFor(muxJob(), handler);
      const r = await advanceFilmJob(env, FILM);

      expect(r?.job.phase).toBe("failed");
      expect(r?.job.error).toBeTruthy();
      // The specific lie this issue is about: a terminal COMPLETED carrying a film with no audio.
      expect(r?.job.phase).not.toBe("done");
      expect(r?.job.finish_unavailable?.delivered).not.toBe("silent_film");
      // Persisted, not just returned.
      expect(read().phase).toBe("failed");
    });
  }

  it("the silent film is still in R2, so failing loses nothing a degrade would have kept", async () => {
    const { env, read } = envFor(muxJob(), submitThrows);
    await advanceFilmJob(env, FILM);
    // silent_film_key is untouched: a resubmit can remux it. That is why failing is safe here and
    // why the degrade was never buying the user anything a retry could not.
    expect(read().silent_film_key).toBe(SILENT);
  });
});

describe("cf#746(a) inverse controls: the degrades that SHOULD survive", () => {
  it("VIDEO_FINISH_URL unset -> still degrades to done with the silent film (#519, by design)", async () => {
    const { env, read } = envFor(muxJob(), submitThrows);
    (env as unknown as Record<string, unknown>).VIDEO_FINISH_URL = "";
    const r = await advanceFilmJob(env, FILM);
    expect(r?.job.phase).toBe("done");
    expect(r?.job.finish_unavailable?.at).toBe("mux");
    expect(r?.job.finish_unavailable?.delivered).toBe("silent_film");
    expect(r?.job.film_key).toBe(SILENT);
    expect(read().finish_unavailable?.at).toBe("mux");
  });
});

describe("cf#746(a) parity: assemble and mux now answer the identical condition the same way", () => {
  const assembleJob = () => ({
    film_id: FILM,
    project: "p",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
    phase: "assemble" as const,
    finish_shots: [{ shot_id: "shot_01", clip_key: CLIP, status: "done" }],
    created_at: 0,
  });

  it("the same dead origin fails at BOTH legs, not one each way", async () => {
    const a = envFor(assembleJob(), submitThrows);
    const ra = await advanceFilmJob(a.env, FILM);
    const m = envFor(muxJob(), submitThrows);
    const rm = await advanceFilmJob(m.env, FILM);

    expect(ra?.job.phase).toBe("failed"); // already true before the fix
    expect(rm?.job.phase).toBe("failed"); // the fix
    expect(rm?.job.phase).toBe(ra?.job.phase);
  });
});
