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
      keyframe_backend: "keyframe",
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
    expect(seed.motionBackend).toBeNull();
    expect(seed.keyframeBackend).toBe("keyframe");
  });

  // cf#833: this case PINNED the defect. It asserted that a done doc carrying no key resolves to the
  // deterministic film.mp4 and that the poll view reports that key -- i.e. it asserted the guess, and
  // the guess is what made both R2-existence heals unreachable. The doc is now reported honestly and
  // the store is probed by the caller (adoptFilmOutputKeyFromStore), which is what #99 actually asked
  // for. The #99 behaviour it was protecting is covered end to end in
  // tests/film-deliverable-gate-cf833.test.ts ("the #99 heal").
  it("reports no key for a done full render whose doc lost it, instead of guessing one (cf#833)", () => {
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
    expect(resolveFilmOutputKey(job)).toBeUndefined();
    const view = filmJobToPollView(job, null);
    expect(view.status).toBe("COMPLETED");
    // No fabricated download target on the poll view. The renders row gets its output_key from the
    // store-probing backfill in renders-db.ts, which this guess used to disable.
    expect((view.output as { output_key?: string })?.output_key).toBeUndefined();
    // The deterministic key is still the right thing to PROBE, and still exported for that use.
    expect(defaultFilmOutputKey("film-6df85aed")).toBe("renders/film-6df85aed/film.mp4");
  });

  it("resolveFilmOutputKey prefers film_key, then silent_film_key", () => {
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
