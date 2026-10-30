import { describe, it, expect } from "vitest";
import { installVfFetch } from "./install-vf-fetch.js";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { _resetModuleDiscoveryCache } from "../src/modules/registry.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import { FINISH_TRANSPORT_HOLD_MAX_SECONDS, encodeAssembleWait } from "../src/video-finish-assemble.js";

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
/** core#377: a dead door holds first. These cases are about what happens once that hold has run out. */
const holdSpent = () => ({
  assemble_wait: encodeAssembleWait({
    firstAt: Date.now() - (FINISH_TRANSPORT_HOLD_MAX_SECONDS + 1) * 1000,
    attempts: 5,
    nextAt: Date.now() - 1,
    detail: "d",
  }),
});
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
      const { env, read } = envFor(muxJob(holdSpent()), handler);
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

  it("core#377: a dead door holds first, and the film is neither failed nor done", async () => {
    const { env, read } = envFor(muxJob(), submitThrows);
    const r = await advanceFilmJob(env, FILM);
    expect(r?.job.phase).toBe("mux");
    expect(read().assemble_wait).toBeTruthy();
    expect(read().finish_incomplete).toBeUndefined();
  });

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
    expect(r?.job.finish_unavailable?.retained).toBe("silent_film");
    expect(r?.job.finish_unavailable?.delivered).toBeUndefined();
    expect(r?.job.film_key).toBeUndefined();
    expect(r?.job.error).toMatch(/video-finish tier not installed/i);
    expect(r?.job.error).not.toMatch(/shipped silent film/);
    expect(read().silent_film_key).toBe(SILENT);
  });

  it("a staged song whose mux tier is absent notifies render.failed and does not set film_key", async () => {
    _resetModuleDiscoveryCache();
    const invokes: Array<Record<string, unknown>> = [];
    const { env } = envFor(muxJob({ beats_read: true }), submitThrows);
    const rec = env as unknown as Record<string, unknown>;
    rec.VIDEO_FINISH_URL = "";
    rec.MODULE_NOTIFY = {
      fetch: async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/module.json")) {
          return json({
            name: "notify-stub",
            version: "1.0.0",
            api: "vivijure-module/2",
            hooks: ["notify"],
            config_schema: {},
          }, 200);
        }
        if (u.endsWith("/invoke")) {
          const body = JSON.parse(String(init?.body)) as { input?: Record<string, unknown> };
          invokes.push(body.input ?? {});
          return json({ ok: true, output: { delivered: ["stub"] } }, 200);
        }
        return json({ ok: false }, 404);
      },
    };
    const r = await advanceFilmJob(env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.film_key).toBeUndefined();
    expect(r?.job.finish_unavailable?.retained).toBe("silent_film");
    expect(invokes).toEqual([{
      event: "render.failed",
      film_id: FILM,
      project: "p",
      download_url: `https://presigned/${SILENT}`,
    }]);
  });

  it("a 502 from the URL beat door retries instead of destroying a paid film", async () => {
    // The module door was already fixed. This is the NO-MODULE door: analyzeViaUrl. The fixture
    // router in installVfFetch keys on the substring "video-finish", so the beat door is given a
    // host under the same fake origin to route through the handler below.
    _resetModuleDiscoveryCache();
    let analyzeCalls = 0;
    const { env, read } = envFor(muxJob({ beats_read: false }), async (u) => {
      if (u.includes("/analyze")) {
        analyzeCalls += 1;
        // An edge error page, the shape that used to throw out of resp.json().
        return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 });
      }
      throw new TypeError("fetch failed");
    });
    (env as unknown as Record<string, unknown>).AUDIO_BEAT_SYNC_URL = "https://beats.video-finish.test";

    const first = await advanceFilmJob(env, FILM);
    expect(first?.job.phase).toBe("mux");
    expect(first?.job.error).toBe(
      "beats read transient (attempt 1/3), retrying: beat-sync container returned HTTP 502",
    );
    // Persisted, so the counter survives the tick boundary and the cap is real.
    expect(read().beat_attempts).toBe(1);
    expect(read().phase).toBe("mux");

    const second = await advanceFilmJob(env, FILM);
    expect(second?.job.phase).toBe("mux");
    expect(read().beat_attempts).toBe(2);

    const third = await advanceFilmJob(env, FILM);
    expect(third?.job.phase).toBe("failed");
    expect(third?.job.error).toMatch(/beats were not read: beat-sync container returned HTTP 502/);
    expect(read().beat_attempts).toBe(3);
    // Three real reads, so the retry is a retry and not a replayed result.
    expect(analyzeCalls).toBe(3);
    // Conrad ruling, held through the beat leg too: nothing is discarded and nothing is linked.
    expect(read().silent_film_key).toBe(SILENT);
    expect(read().film_key).toBeUndefined();
  });

  it("a transient beat read stays in phase, then fails once the finish cap is used", async () => {
    _resetModuleDiscoveryCache();
    const calls: Array<{ job_id?: string; project?: string; film_key?: string }> = [];
    const { env, read } = envFor(muxJob({ beats_read: false }), submitThrows);
    (env as unknown as Record<string, unknown>).MODULE_BEAT = {
      fetch: async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/module.json")) {
          return json({
            name: "audio-beat-sync",
            version: "1.0.0",
            api: "vivijure-module/2",
            hooks: ["score"],
            config_schema: { clip_seconds: { type: "float", default: 8 } },
          }, 200);
        }
        if (u.endsWith("/invoke")) {
          const body = JSON.parse(String(init?.body)) as {
            input?: { film_key?: string };
            context?: { job_id?: string; project?: string };
          };
          calls.push({
            job_id: body.context?.job_id,
            project: body.context?.project,
            film_key: body.input?.film_key,
          });
          return json({ ok: false, error: "cold" }, 200);
        }
        return json({ ok: false }, 404);
      },
    };

    const first = await advanceFilmJob(env, FILM);
    expect(first?.job.phase).toBe("mux");
    expect(first?.job.error).toBe("beats read transient (attempt 1/3), retrying: cold");
    expect(first?.job.beat_attempts).toBe(1);
    expect(read().beats_read).toBe(false);
    expect(calls[0]).toEqual({ job_id: FILM, project: "p", film_key: `beat-analyze/${FILM}` });

    const second = await advanceFilmJob(env, FILM);
    expect(second?.job.phase).toBe("mux");
    expect(second?.job.beat_attempts).toBe(2);

    const third = await advanceFilmJob(env, FILM);
    expect(third?.job.phase).toBe("failed");
    expect(third?.job.error).toBe("beats were not read: cold");
    expect(third?.job.beat_attempts).toBe(3);
  });
});

// A dead concat door used to mark the film done and hand back the loose clips. The clips stay
// named on finish_unavailable, and they stay in R2, but the phase is failed. A skipped join is
// a failed film. The mux leg fails too when a song was staged: a silent cut is not that film.
describe("core#327: both legs answer an unreachable tier by failing, and they name what is in R2", () => {
  const assembleJob = (over: object = {}) => ({
    ...over,
    film_id: FILM,
    project: "p",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
    phase: "assemble" as const,
    finish_shots: [{ shot_id: "shot_01", clip_key: CLIP, status: "done" }],
    created_at: 0,
  });

  it("THE RULE: a dead origin DECLARES and delivers what exists -- clips at assemble, nothing at mux", async () => {
    const a = envFor(assembleJob(holdSpent()), submitThrows);
    const ra = await advanceFilmJob(a.env, FILM);
    const m = envFor(muxJob(holdSpent()), submitThrows);
    const rm = await advanceFilmJob(m.env, FILM);

    // ASSEMBLE: the clips stay in R2, and the reason is on the job, but the film is failed.
    // A skipped join is not a finished film.
    expect(ra?.job.phase).toBe("failed");
    expect(ra?.job.finish_unavailable?.at).toBe("assemble");
    expect(ra?.job.finish_unavailable?.retained).toBe("clips");
    expect(ra?.job.finish_unavailable?.delivered).toBeUndefined();
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
    const a = envFor(assembleJob(holdSpent()), gateway);
    const r = await advanceFilmJob(a.env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.finish_unavailable?.retained).toBe("clips");
    expect(r?.job.finish_unavailable?.delivered).toBeUndefined();
  });

  it("a container that RAN and reported a failed job still fails loud", async () => {
    const a = envFor(assembleJob(), statusFailed);
    const r = await advanceFilmJob(a.env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/ffmpeg exploded/);
    expect(r?.job.finish_unavailable).toBeUndefined();
  });
});
