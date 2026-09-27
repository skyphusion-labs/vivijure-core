import { describe, it, expect } from "vitest";
import { installVfFetch } from "./install-vf-fetch.js";
import { craftFilmBytes, r2WithObjects } from "./helpers/mp4.js";
import { validateFilmArtifact, FILM_MIN_BYTES, CLIP_MAX_DURATION_S } from "../src/clip-validate.js";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#835: the assembled film was accepted on PRESENCE alone. Both decision points
// (`r2ObjectExists` in the orchestrator, `adoptFilmOutputKeyFromStore` in film-output-key) read
// `head(key) !== null` and discarded the size, so a 0-byte film.mp4 satisfied the #122 R2 shortcut
// and shipped as `done`, while the CLIPS got a real structural gate the whole time.
//
// Every "fail" below is paired with the file that SHOULD pass, built by the same crafter, so the
// gate is shown to distinguish rather than merely refuse.

const KEY = "renders/film-835/film.mp4";

describe("cf#835: the film artifact is judged, not merely counted", () => {
  const validate = (objects: Record<string, Uint8Array | number>) =>
    validateFilmArtifact({ R2_RENDERS: r2WithObjects(objects) } as unknown as Env, KEY);

  it("a 0-byte film.mp4 FAILS (the headline case: it used to ship as done)", async () => {
    const r = await validate({ [KEY]: new Uint8Array(0) });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/0 bytes/);
    expect(r.checks.bytes).toBe(0);
  });

  it("a truncated film under the byte floor FAILS", async () => {
    const r = await validate({ [KEY]: new Uint8Array(FILM_MIN_BYTES - 1) });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/truncated or empty/);
  });

  it("a big body that is not an mp4 FAILS on the box tree, not on its size", async () => {
    const noise = new Uint8Array(64 * 1024).fill(0x5a);
    const r = await validate({ [KEY]: noise });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/not a valid mp4/);
    expect(r.checks.bytes).toBe(64 * 1024);
  });

  it("an mp4 with no video track FAILS (audio-only container)", async () => {
    const r = await validate({ [KEY]: craftFilmBytes({ audioOnly: true }) });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/no video track/);
  });

  it("a zero-frame video track FAILS", async () => {
    const r = await validate({ [KEY]: craftFilmBytes({ frames: 0 }) });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/zero frames/);
  });

  it("a real film PASSES, and the parse reports what the crafter put in it", async () => {
    const r = await validate({ [KEY]: craftFilmBytes({ durationS: 8, frames: 192, width: 1920, height: 1080 }) });
    expect(r.verdict).toBe("pass");
    expect(r.checks.duration_s).toBeCloseTo(8, 3);
    expect(r.checks.frames).toBe(192);
    expect(r.checks.width).toBe(1920);
    expect(r.checks.height).toBe(1080);
  });

  it("A LONG FILM PASSES: the clip judge's 900s runaway cap must NOT apply to a film", async () => {
    const twentyMinutes = 1200;
    expect(twentyMinutes).toBeGreaterThan(CLIP_MAX_DURATION_S); // the trap this case exists for
    const r = await validate({ [KEY]: craftFilmBytes({ durationS: twentyMinutes, frames: 28800 }) });
    expect(r.verdict).toBe("pass");
  });

  it("an ABSENT film FAILS (this is what the done gate rides on), not skips", async () => {
    const r = await validate({});
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/not found in R2/);
  });

  it("present and over the floor but with an unreadable body SKIPS: a read blip is not a verdict", async () => {
    // The number form means "HEAD says this many bytes, GET models no body".
    const r = await validate({ [KEY]: 5_000_000 });
    expect(r.verdict).toBe("skip");
    expect(r.reason).toMatch(/could not be read/);
  });
});

// --- the same gate, on the real done path -----------------------------------------------------

const FILM = "film-835-e2e";
const SILENT = `renders/${FILM}/film-silent.mp4`;

function envFor(job: object, objects: Record<string, Uint8Array | number>) {
  let stored = JSON.stringify(job);
  const r2 = r2WithObjects(objects);
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string, opts?: { range?: { offset: number; length: number } }) =>
        key === filmJobDocKey(FILM) ? { text: async () => stored } : r2.get(key, opts),
      head: async (key: string) =>
        key === filmJobDocKey(FILM) ? { size: stored.length } : r2.head(key),
      put: async (key: string, val: string) => {
        if (key === filmJobDocKey(FILM)) stored = val;
      },
    },
    PRESIGNER: {
      presignGet: async (key: string) => `https://presigned/${key}`,
      presignPut: async (key: string) => `https://presigned-put/${key}`,
    },
  };
  return { env: env as unknown as Env, read: () => JSON.parse(stored) as FilmJob };
}

const muxJob = () => ({
  film_id: FILM,
  project: "p",
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
  phase: "mux" as const,
  silent_film_key: SILENT,
  created_at: 0,
});

describe("cf#835 on the done path: a 0-byte film does not reach COMPLETED", () => {
  it("0 bytes at the delivered key -> phase failed, with the size in the error", async () => {
    const { env, read } = envFor(muxJob(), { [SILENT]: new Uint8Array(0) });
    const r = await advanceFilmJob(env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/0 bytes/);
    expect(read().phase).toBe("failed");
  });

  it("POSITIVE CONTROL: the identical job with a real film at that key completes", async () => {
    const { env } = envFor(muxJob(), { [SILENT]: craftFilmBytes() });
    const r = await advanceFilmJob(env, FILM);
    expect(r?.job.phase).toBe("done");
    expect(r?.job.film_key).toBe(SILENT);
  });
});

// --- the container contract ------------------------------------------------------------------

describe("cf#835: 'completed' with no result body is a FAILURE, not a synthesized ok:true", () => {
  const json = (b: unknown, status: number) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  it("a status of completed carrying nothing fails the render instead of inventing success", async () => {
    const job = {
      film_id: FILM,
      project: "p",
      scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
      phase: "mux" as const,
      silent_film_key: SILENT,
      audio_key: `renders/${FILM}/bed.wav`,
      mux_output_key: `renders/${FILM}/film-audio.mp4`,
      created_at: 0,
    };
    const { env } = envFor(job, { [SILENT]: craftFilmBytes() });
    (env as unknown as Record<string, unknown>).VIDEO_FINISH_URL = "https://video-finish.test";
    (env as unknown as Record<string, unknown>).MEDIA_FINISH_TOKEN = "t";
    installVfFetch(async (input) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u.includes("/async/finish")) return json({ ok: true, jobId: "job-x", status: "pending" }, 202);
      // The shape the synthesis used to paper over: completed, and nothing in it.
      if (u.includes("/async/status/")) return json({ ok: true, status: "completed" }, 200);
      return json({ ok: false }, 404);
    });

    const r = await advanceFilmJob(env, FILM);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/completed with no result body/);
    // The specific lie: film_key silently advanced to an output key nothing ever wrote.
    expect(r?.job.film_key).not.toBe(`renders/${FILM}/film-audio.mp4`);
  });
});
