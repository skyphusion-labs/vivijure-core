import { describe, expect, it } from "vitest";
import {
  filmJobToPollView,
  filmRenderRowSeedFromJob,
  isFilmJobId,
  normalizeFilmScenes,
} from "../src/film-render-bridge.js";
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
});
