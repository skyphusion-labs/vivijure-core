import { describe, expect, it } from "vitest";
import {
  incompleteFilmError,
  missingSceneIds,
  startFilmJob,
} from "../src/film-orchestrator.js";

describe("missingSceneIds / incompleteFilmError", () => {
  const scenes = ["shot_01", "shot_02", "shot_03"].map((shot_id) => ({
    shot_id,
    prompt: shot_id,
    seconds: 4,
  }));

  it("is empty when every storyboard shot is present", () => {
    expect(missingSceneIds(scenes, ["shot_01", "shot_02", "shot_03"])).toEqual([]);
  });

  it("names every missing storyboard shot", () => {
    expect(missingSceneIds(scenes, ["shot_01"])).toEqual(["shot_02", "shot_03"]);
  });

  it("writes an incomplete-film error the UI can show as FAILED", () => {
    expect(incompleteFilmError("clips", 7, 10, ["shot_03", "shot_08", "shot_10"], "shot_03: veo 7003"))
      .toBe("incomplete film -- clips 7/10 (missing: shot_03, shot_08, shot_10) -- shot_03: veo 7003");
  });
});

const kfMod = {
  name: "keyframe",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_KEYFRAME",
  hooks: ["keyframe" as const],
  config_schema: {},
  ui: { section: "keyframe", order: 10 },
} as unknown as RegisteredModule;

describe("a partial keyframe set fails the film", () => {
  it("does not mark done when a storyboard shot has no keyframe", async () => {
    const objects = new Map<string, string>();
    const env = {
      KEYFRAME_PARALLEL: "1",
      MODULE_KEYFRAME: {
        fetch: async (url: string, init?: RequestInit) => {
          const path = String(url);
          if (path.endsWith("/module.json")) {
            return new Response(JSON.stringify(kfMod), { headers: { "content-type": "application/json" } });
          }
          if (path.endsWith("/invoke")) {
            return new Response(JSON.stringify({
              ok: true,
              output: {
                project: "film",
                keyframes: [
                  { shot_id: "shot_01", keyframe_key: "renders/film/keyframes/shot_01.png" },
                  { shot_id: "shot_02", keyframe_key: "renders/film/keyframes/shot_02.png" },
                ],
              },
            }), { headers: { "content-type": "application/json" } });
          }
          return new Response("no", { status: 404 });
        },
      },
      R2_RENDERS: {
        async put(key: string, value: string) { objects.set(key, value); },
        async get(key: string) {
          const v = objects.get(key);
          return v === undefined ? null : { text: async () => v };
        },
        async list() { return { objects: [] }; },
      },
    };
    const job = await startFilmJob(env as never, {
      project: "film",
      bundle_key: "bundles/x.tar.gz",
      scenes: [1, 2, 3].map((n) => ({ shot_id: `shot_0${n}`, prompt: `s${n}`, seconds: 4 })),
      keyframe_backend: "keyframe",
      motion_backend: "cf-seedance",
      keyframes_only: true,
    });
    expect(job.phase).toBe("failed");
    expect(job.error).toMatch(/incomplete film -- keyframes 2\/3/);
    expect(job.error).toMatch(/shot_03/);
  });
});
