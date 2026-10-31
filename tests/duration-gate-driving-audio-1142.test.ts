import { describe, it, expect } from "vitest";
import { installVfFetch, vfAsyncFinish } from "./install-vf-fetch.js";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import { plannedForDurationGate } from "../src/film-model.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { RegisteredModule } from "../src/modules/types.js";

// vivijure-cf#1142: measured on film-4353535c, three 6s shots, each with a short line on
// cf-p-video-avatar. 2.96s delivered against a 3.00s floor failed a finished, paid-for film.

describe("plannedForDurationGate", () => {
  it("gates a driving-audio shot against a shorter line", () => {
    expect(plannedForDurationGate({ a: 6 }, { a: 3 }, true)).toEqual({ a: 3 });
  });
  it("keeps the board when the line is longer, unmeasured, or not a number", () => {
    expect(plannedForDurationGate({ a: 6 }, { a: 9 }, true)).toEqual({ a: 6 });
    expect(plannedForDurationGate({ a: 6, b: 6 }, { a: 3 }, true)).toEqual({ a: 3, b: 6 });
    expect(plannedForDurationGate({ a: 6 }, { a: Number.NaN }, true)).toEqual({ a: 6 });
    expect(plannedForDurationGate({ a: 6 }, undefined, true)).toEqual({ a: 6 });
  });
  it("leaves every other door on the board", () => {
    expect(plannedForDurationGate({ a: 6 }, { a: 3 }, false)).toEqual({ a: 6 });
  });
  it("does not mutate its input", () => {
    const planned = { a: 6 };
    plannedForDurationGate(planned, { a: 3 }, true);
    expect(planned).toEqual({ a: 6 });
  });
});

const FILM = "film-gate-1142";
const OUT = `renders/${FILM}/film.mp4`;
const CLIP = `renders/${FILM}/shots/shot_01.mp4`;

const door = (name: string, driving: boolean) => ({
  name, version: "0.1.0", api: "vivijure-module/2" as const, binding: "MODULE_X",
  hooks: ["motion.backend" as const], config_schema: {},
  ui: { section: "motion", order: 1, locality: "cloud" as const },
  usage: { native_audio: false, voice: "cast_tts", scatter_native_audio: false, min_seconds: 1, max_seconds: 15, driving_audio: driving },
}) as unknown as RegisteredModule;

async function assemble(delivered: number, modules: RegisteredModule[], motion: string) {
  let stored = JSON.stringify({
    film_id: FILM, project: "p", phase: "assemble", created_at: 0, motion_backend: motion,
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 6 }],
    finish_shots: [{ shot_id: "shot_01", clip_key: CLIP, status: "done" }],
    dialogue_audio_seconds: { shot_01: 3 },
  });
  const env = {
    R2_RENDERS: {
      get: async (key: string) => (key === filmJobDocKey(FILM) ? { text: async () => stored } : null),
      head: async (key: string) => (key === filmJobDocKey(FILM) ? { size: 4096 } : null),
      put: async (key: string, val: string) => { if (key === filmJobDocKey(FILM)) stored = val; },
    },
    PRESIGNER: {
      presignGet: async (key: string) => `https://presigned/${key}`,
      presignPut: async (key: string) => `https://presigned-put/${key}`,
    },
    VIDEO_FINISH_URL: "https://video-finish.test",
    MEDIA_FINISH_TOKEN: "test-tok",
  };
  installVfFetch(vfAsyncFinish({ ok: true, key: OUT, durationSeconds: delivered, shots: 1, clipDurations: [delivered] }));
  const r = await advanceFilmJob(env as unknown as Env, FILM, modules);
  return r?.job as FilmJob;
}

describe("the gate on a real assemble", () => {
  it("passes a clip that follows its short line on an audio-driven door", async () => {
    const job = await assemble(2.96, [door("avatar", true)], "avatar");
    expect(job.error ?? "").not.toContain("duration gate");
  });
  it("still fails a truncated clip on an audio-driven door", async () => {
    const job = await assemble(0.5, [door("avatar", true)], "avatar");
    expect(job.phase).toBe("failed");
    expect(job.error).toContain("duration gate");
  });
  it("CONTROL: the same short clip on a door that does not follow audio still fails", async () => {
    const job = await assemble(2.96, [door("plain", false)], "plain");
    expect(job.phase).toBe("failed");
    expect(job.error).toContain("duration gate");
  });
});
