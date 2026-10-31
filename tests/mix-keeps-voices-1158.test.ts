import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#1158, measured on film-accba746: audio-mix answered 413, and the bare bed replaced the voices.
afterEach(() => vi.unstubAllGlobals());

const FILM = "film-mix-1158";
const SILENT = `renders/${FILM}/film.mp4`;
const BED = "out/bed.mp3";

function setup(mixStatus: number, over: Record<string, unknown> = {}, mixUrl = "https://audio-mix.test") {
  let stored = JSON.stringify({
    film_id: FILM, project: "p", phase: "mux", created_at: 0, scenes: [{ shot_id: "s1", prompt: "x", seconds: 6 }],
    silent_film_key: SILENT, audio_key: BED, bundle_key: "b", beats_read: true,
    dialogue_audio: { s1: "audio/s1.wav" },
    dialogue_lines: [{ shot_id: "s1", text: "A line.", voice_id: "hera" }],
    ...over,
  });
  const urls: string[] = [];
  const env = {
    R2_RENDERS: {
      get: async (k: string) => (k === filmJobDocKey(FILM) ? { text: async () => stored } : null),
      head: async (k: string) => (k === SILENT || k === filmJobDocKey(FILM) ? { size: 4096 } : null),
      put: async (k: string, v: string) => { if (k === filmJobDocKey(FILM)) stored = v; },
      list: async () => ({ objects: [] }),
    },
    PRESIGNER: {
      presignGet: async (k: string) => `https://g/${k}`,
      presignPut: async (k: string) => `https://p/${k}`,
    },
    VIDEO_FINISH_URL: "https://video-finish.test",
    AUDIO_MIX_URL: mixUrl,
    MEDIA_FINISH_TOKEN: "t",
  };
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("audio-mix")) return new Response(JSON.stringify({ ok: false, error: "tracks[0] too large" }), { status: mixStatus });
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  });
  return { env: env as unknown as Env, urls, read: () => JSON.parse(stored) as FilmJob };
}

describe("a refused mix on a film with spoken lines", () => {
  it("keeps the voices and does not mux the bed", async () => {
    const { env, urls, read } = setup(413);
    await advanceFilmJob(env, FILM, []);
    const j = read();
    expect(urls.some((u) => u.includes("audio-mix"))).toBe(true);
    expect(j.film_key).toBe(SILENT);
    expect(urls.some((u) => u.includes("video-finish"))).toBe(false);
  });

  it("says the bed is what was lost", async () => {
    const { env, read } = setup(413);
    await advanceFilmJob(env, FILM, []);
    const entry = (read().finish_incomplete ?? []).find((e) => e.stage === "mix");
    expect(entry?.detail).toBe("audio-mix answered 413");
    expect(entry?.kept).toMatch(/voices/);
    expect(entry?.kept).toMatch(/music bed is not in the film/);
  });
});

describe("no audio-mix door on the host", () => {
  it("a film with spoken lines keeps its voices, and says the bed is lost", async () => {
    const { env, urls, read } = setup(413, {}, "");
    await advanceFilmJob(env, FILM, []);
    const j = read();
    expect(j.film_key).toBe(SILENT);
    expect(urls.some((u) => u.includes("video-finish"))).toBe(false);
    const entry = (j.finish_incomplete ?? []).find((e) => e.stage === "mix");
    expect(entry?.code).toBe("unavailable");
    expect(entry?.kept).toMatch(/music bed is not in the film/);
  });

  it("CONTROL: a film with no spoken lines still gets its bed", async () => {
    const { env, urls, read } = setup(413, { dialogue_audio: undefined, dialogue_lines: undefined }, "");
    await advanceFilmJob(env, FILM, []);
    expect(urls.some((u) => u.includes("video-finish"))).toBe(true);
    expect(read().film_key).toBeUndefined();
  });
});
