import { describe, expect, it } from "vitest";
import {
  filmJobToPollView,
  filmRenderRowSeedFromJob,
  isFilmJobId,
  normalizeFilmScenes,
} from "../src/film-render-bridge.js";
import { defaultFilmOutputKey, resolveFilmOutputKey } from "../src/film-output-key.js";
import type { FilmJob } from "../src/film-model.js";

describe("film-render-bridge", () => {
  it("isFilmJobId recognizes film-* ids", () => {
    expect(isFilmJobId("film-abc")).toBe(true);
    expect(isFilmJobId("scatter-abc")).toBe(false);
  });

  it("normalizeFilmScenes drops invalid entries", () => {
    const scenes = normalizeFilmScenes([
      { shot_id: "s1", prompt: "a cat", seconds: 4 },
      { shot_id: "", prompt: "x", seconds: 4 },
      null,
    ]);
    expect(scenes).toEqual([{ shot_id: "s1", prompt: "a cat", seconds: 4 }]);
  });

  it("filmJobToPollView maps keyframes-only done job", () => {
    const job: FilmJob = {
      film_id: "film-test",
      project: "demo",
      bundle_key: "bundles/demo.tar.gz",
      scenes: [{ shot_id: "s1", prompt: "a", seconds: 4 }],
      motion_backend: null,
      motion_config: {},
      finish_config: {},
      speech_config: {},
      film_finish_config: {},
      master_config: {},
      keyframes_only: true,
      keyframe_binding: "MODULE_KEYFRAME",
      phase: "done",
      created_at: Date.now() - 5000,
      phase_started_at: Date.now() - 5000,
      keyframes: [{ shot_id: "s1", keyframe_key: "renders/demo/keyframes/s1.png" }],
    };
    const view = filmJobToPollView(job, null);
    expect(view.status).toBe("COMPLETED");
    expect(view.jobId).toBe("film-test");
    expect((view.output as { keyframes?: unknown[] })?.keyframes).toHaveLength(1);
  });

  it("filmRenderRowSeedFromJob matches poll status", () => {
    const job: FilmJob = {
      film_id: "film-row",
      project: "demo",
      bundle_key: "bundles/demo.tar.gz",
      scenes: [],
      motion_backend: null,
      motion_config: {},
      finish_config: {},
      speech_config: {},
      film_finish_config: {},
      master_config: {},
      keyframes_only: true,
      keyframe_binding: "MODULE_KEYFRAME",
      phase: "done",
      created_at: Date.now(),
      phase_started_at: Date.now(),
    };
    const seed = filmRenderRowSeedFromJob(job);
    expect(seed.jobId).toBe("film-row");
    expect(seed.status).toBe("COMPLETED");
    expect(seed.mode).toBe("keyframes-only");
  });

  it("resolveFilmOutputKey falls back to deterministic film.mp4 for done full renders (#99)", () => {
    const job: FilmJob = {
      film_id: "film-6df85aed",
      project: "local97_verify_secrets",
      bundle_key: "bundles/local97.tar.gz",
      scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
      motion_backend: "own-gpu",
      motion_config: {},
      finish_config: {},
      speech_config: {},
      film_finish_config: {},
      master_config: {},
      keyframe_binding: "MODULE_KEYFRAME",
      phase: "done",
      created_at: Date.now(),
      phase_started_at: Date.now(),
    };
    expect(resolveFilmOutputKey(job)).toBe(defaultFilmOutputKey("film-6df85aed"));
    const view = filmJobToPollView(job, null);
    expect(view.status).toBe("COMPLETED");
    expect((view.output as { output_key?: string })?.output_key).toBe(
      "renders/film-6df85aed/film.mp4",
    );
  });

  it("resolveFilmOutputKey prefers silent_film_key before deterministic fallback", () => {
    const silent = "renders/film-x/film.mp4";
    const job: FilmJob = {
      film_id: "film-x",
      project: "demo",
      bundle_key: "bundles/demo.tar.gz",
      scenes: [],
      motion_backend: null,
      motion_config: {},
      finish_config: {},
      speech_config: {},
      film_finish_config: {},
      master_config: {},
      keyframe_binding: null,
      phase: "done",
      created_at: Date.now(),
      phase_started_at: Date.now(),
      silent_film_key: silent,
    };
    expect(resolveFilmOutputKey(job)).toBe(silent);
  });
});
