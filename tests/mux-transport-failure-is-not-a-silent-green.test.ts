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

// core#327 NARROWS the parity case that used to live here. It is not a reversal of cf#746(a): the
// three mux cases above are untouched and stay green. What is retired is the assertion that the two
// legs must produce the same PHASE on a dead origin.
//
// WHY THE OLD ASSERTION WAS WRONG, stated here so the next reader finds the argument instead of
// re-deriving it or re-flipping it. cf#746(a)'s rationale is written in this file, four lines above:
// "the silent film is still in R2, so failing loses nothing a degrade would have kept". That is TRUE
// AT MUX and FALSE AT ASSEMBLE.
//
//   mux      the silent film survives in R2, so failing costs the user nothing they would have had.
//   assemble failing loses the clips. Measured, not assumed: FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS
//            is 60, a double-click guard and not a resume, so a resubmit minutes later is a new
//            film_id, new clip keys, and re-paid keyframes and i2v on RunPod.
//
// Both outcomes are terminal and both need a re-spend to get a film; the degrade additionally hands
// over clips that were already paid for. The parity assertion generalised a mux-specific reason to a
// leg where the reason is false.
//
// AND THE OFFENCE WAS NEVER PARTIAL DELIVERY, IT WAS MISLABELLING. Conrad's words on the original
// defect: the studio was "partially assembling the movies and CALLING THEM 'complete'". A silent
// film presented as complete is a lie about content. Per-shot clips declared through
// finish_unavailable delivered:"clips" are a real partial deliverable, labelled partial -- and that
// declaration is visible to a user as of cf#836 (the payload keys) and cf#833 (filmDeliverableExpected
// exempts the clips shape from the deliverable gate). A degrade nobody can see is the defect; a
// degrade the panel renders is a product decision.
describe("core#327: both legs answer an unreachable tier by the same RULE, and deliver what exists", () => {
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

    // ASSEMBLE: the clips exist, so they are delivered, and the render says so rather than reading
    // green. This is #519's sentence: "you can at least get your clips if you close your laptop".
    expect(ra?.job.phase).toBe("done");
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
    expect(r?.job.phase).toBe("done");
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
