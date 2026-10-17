import { describe, it, expect } from "vitest";
import { installVfFetch } from "./install-vf-fetch.js";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// cf#746(a): a TRANSPORT failure at mux must not ship a silent film as COMPLETED.
//
// submitAsync returns failed on the FIRST attempt with no retry (video-finish-assemble.ts), so a
// single blip at mux used to convert a film-with-audio into a silent film marked COMPLETED.
// A staged song whose mux door misses now fails the film. The silent cut stays in R2.
// A film with no song can still finish on that silent cut when the mux tier is absent.
//
// hasAudio:false with a staged song is the same class (mux-silent-bed-honesty.test.ts): the bed
// was not attached, so the film fails. hasAudio absent stays a success.
//
// A staged song whose beats were not read fails before mux. Fixtures that are about mux set
// beats_read so this file still measures the mux door.

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
  beats_read: true,
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
    // silent_film_key is untouched: a resubmit can remux it.
    expect(read().silent_film_key).toBe(SILENT);
  });

  it("a staged song whose beats were not read fails before mux", async () => {
    const { env, read } = envFor(muxJob({ beats_read: false }), submitThrows);
    const r = await advanceFilmJob(env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/beats were not read: AUDIO_BEAT_SYNC_URL unset/);
    expect(read().phase).toBe("failed");
    expect(read().silent_film_key).toBe(SILENT);
  });
});

describe("cf#746(a) inverse controls: the degrades that SHOULD survive", () => {
  it("VIDEO_FINISH_URL unset with a staged song fails the film; the song is not dropped", async () => {
    const { env, read } = envFor(muxJob({ beats_read: true }), submitThrows);
    (env as unknown as Record<string, unknown>).VIDEO_FINISH_URL = "";
    const r = await advanceFilmJob(env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.finish_unavailable?.at).toBe("mux");
    expect(r?.job.error).toMatch(/video-finish tier not installed/i);
    expect(read().silent_film_key).toBe(SILENT);
  });
});

// A dead concat door used to mark the film done and hand back the loose clips. The clips stay
// named on finish_unavailable, and they stay in R2, but the phase is failed. A skipped join is
// a failed film. The mux leg fails too when a song was staged: a silent cut is not that film.
describe("core#327: both legs answer an unreachable tier by failing, and they name what is in R2", () => {
  const assembleJob = () => ({
    film_id: FILM,
    project: "p",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
    phase: "assemble" as const,
    finish_shots: [{ shot_id: "shot_01", clip_key: CLIP, status: "done" }],
    created_at: 0,
  });

  it("THE RULE: a dead origin DECLARES and delivers what exists -- clips at assemble, nothing at mux", async () => {
    const a = envFor(assembleJob(), submitThrows);
    const ra = await advanceFilmJob(a.env, FILM);
    const m = envFor(muxJob(), submitThrows);
    const rm = await advanceFilmJob(m.env, FILM);

    // ASSEMBLE: the clips stay in R2, and the reason is on the job, but the film is failed.
    // A skipped join is not a finished film.
    expect(ra?.job.phase).toBe("failed");
    expect(ra?.job.finish_unavailable?.at).toBe("assemble");
    expect(ra?.job.finish_unavailable?.delivered).toBe("clips");
    expect(ra?.job.finish_unavailable?.reason).toMatch(/unreachable/i);
    expect(ra?.job.finish_unavailable?.clips?.map((c) => c.clip_key)).toEqual([CLIP]);
    // NOT a silent green: the film key is absent, so nothing claims a film was produced.
    expect(ra?.job.film_key).toBeUndefined();

    // MUX: the only thing that "exists" is a film with the audio missing, which is a lie about
    // content rather than a partial deliverable. cf#746(a) stands, unchanged.
    expect(rm?.job.phase).toBe("failed");
    expect(rm?.job.finish_unavailable?.delivered).not.toBe("silent_film");
  });

  it("a container that ANSWERS and refuses still fails loud at assemble (#245/#249)", async () => {
    // The distinction the whole change rests on: the app answered. That is not unavailability, and
    // it must not be laundered into an availability degrade.
    const refused = async (u: string) =>
      u.includes("/async/finish") ? json({ ok: false, error: "payload too large" }, 400) : json({ ok: false }, 404);
    const a = envFor(assembleJob(), refused);
    const r = await advanceFilmJob(a.env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/400/);
    expect(r?.job.finish_unavailable).toBeUndefined();
  });

  it("a 202 with no jobId is a refusal, not unavailability", async () => {
    const noJobId = async (u: string) =>
      u.includes("/async/finish") ? json({ ok: true }, 202) : json({ ok: false }, 404);
    const a = envFor(assembleJob(), noJobId);
    const r = await advanceFilmJob(a.env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/no jobId/i);
  });

  it("a 502 from the EDGE is unavailability: the app never answered", async () => {
    const gateway = async (u: string) =>
      u.includes("/async/finish") ? new Response("bad gateway", { status: 502 }) : json({ ok: false }, 404);
    const a = envFor(assembleJob(), gateway);
    const r = await advanceFilmJob(a.env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.finish_unavailable?.delivered).toBe("clips");
  });

  it("a container that RAN and reported a failed job still fails loud", async () => {
    const a = envFor(assembleJob(), statusFailed);
    const r = await advanceFilmJob(a.env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/ffmpeg exploded/);
    expect(r?.job.finish_unavailable).toBeUndefined();
  });
});
