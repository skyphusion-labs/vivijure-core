import { describe, it, expect } from "vitest";
import { installVfFetch, vfAsyncFinish } from "./install-vf-fetch.js";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// F2: audio-master (or any long bed) can push the mux bed over the video-finish container audio
// cap. The container returns ok:true, writes a track-less MP4, and reports hasAudio:false.
// A staged song in that state fails the film. The silent cut stays in R2, and finish_unavailable
// names the mux miss (#245 / #249 / #77). hasAudio absent (an older container that omits the
// field) is unknown, so the prior success behavior must hold. The fixtures set beats_read because
// this file measures the mux result, not the beat door.

function muxEnv(job: object, containerBody: unknown) {
  const filmId = (job as { film_id: string }).film_id;
  let stored = JSON.stringify(job);
  const env: Record<string, unknown> = {
    R2_RENDERS: {
      get: async (key: string) => (key === filmJobDocKey(filmId) ? { text: async () => stored } : null),
      // cf#833: the done transition HEADs the film it is about to stamp on the row, so a fake that
      // answers "nothing exists, ever" describes a world this scenario is not in -- the silent and
      // muxed artifacts are in R2 here, which is what the prose of these cases already says.
      head: async (key: string) => (key === SILENT || key === OUT ? { size: 4096 } : null),
      put: async (key: string, val: string) => { if (key === filmJobDocKey(filmId)) stored = val; },
    },
    PRESIGNER: {
      presignGet: async (key: string) => `https://presigned/${key}`,
      presignPut: async (key: string) => `https://presigned-put/${key}`,
    },
    VIDEO_FINISH_URL: "https://video-finish.test",
    MEDIA_FINISH_TOKEN: "test-tok",
  };
  installVfFetch(vfAsyncFinish(containerBody));
  return { env: env as unknown as Env, read: () => JSON.parse(stored) as FilmJob };
}

const SILENT = "renders/film-mux-honesty/film-silent.mp4";
const OUT = "renders/film-mux-honesty/film-audio.mp4";
const muxJob = (over: object = {}) => ({
  film_id: "film-mux-honesty",
  project: "p",
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }],
  phase: "mux" as const,
  silent_film_key: SILENT,
  audio_key: "renders/film-mux-honesty/bed_mastered.wav",
  mux_output_key: OUT,
  created_at: 0,
  ...over,
});

describe("mux honesty: a dropped bed is an OBSERVABLE degrade, never a silent green (F2)", () => {
  it("hasAudio:false with a staged song fails the film; the silent cut is not called done", async () => {
    const { env, read } = muxEnv(muxJob({ beats_read: true }), { ok: true, key: OUT, hasAudio: false });
    const r = await advanceFilmJob(env, "film-mux-honesty");
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.finish_unavailable?.at).toBe("mux");
    expect(r?.job.finish_unavailable?.reason).toMatch(/could not attach the audio bed/i);
    expect(r?.job.film_key).toBe(SILENT);
    expect(read().phase).toBe("failed");
  });

  it("hasAudio:true -> normal green with the muxed film, no degrade", async () => {
    const { env } = muxEnv(muxJob({ beats_read: true }), { ok: true, key: OUT, hasAudio: true });
    const r = await advanceFilmJob(env, "film-mux-honesty");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.finish_unavailable).toBeUndefined();
    expect(r?.job.film_key).toBe(OUT);
  });

  it("hasAudio absent (older container build) -> back-compat: normal green, no false degrade", async () => {
    const { env } = muxEnv(muxJob({ beats_read: true }), { ok: true, key: OUT });
    const r = await advanceFilmJob(env, "film-mux-honesty");
    expect(r?.job.phase).toBe("done");
    expect(r?.job.finish_unavailable).toBeUndefined();
    expect(r?.job.film_key).toBe(OUT);
  });
});
