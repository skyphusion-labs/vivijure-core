import { describe, expect, it } from "vitest";
import { startFilmJob, startFilmFromKeyframes, type FilmJob } from "../src/film-orchestrator.js";
import { filmDonePayload } from "../src/render-output-payload.js";
import { normalizeKeyframes } from "../src/renders-db.js";
import { keyframeReuseView } from "../src/keyframe-reuse.js";
import type { RegisteredModule } from "../src/modules/types.js";

// The backend returns a stored still, marked `reused: true`, when a shot is asked for again with the
// same parameters (vivijure-backend docs/contract.md, `keyframes`). Before core#532 the core dropped
// the mark at the job doc, so the studio could not tell a reused still from a redrawn one. These tests
// drive the REAL keyframe advance (a module invoke through startFilmJob) and read the job doc and the
// render payload it produces.

const kfMod = {
  name: "keyframe",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_KEYFRAME",
  hooks: ["keyframe" as const],
  config_schema: {},
  ui: { section: "keyframe", order: 10 },
} as unknown as RegisteredModule;

function envReturning(keyframes: unknown[]) {
  const objects = new Map<string, string>();
  return {
    KEYFRAME_PARALLEL: "1",
    MODULE_KEYFRAME: {
      fetch: async (url: string) => {
        const path = String(url);
        if (path.endsWith("/module.json")) {
          return new Response(JSON.stringify(kfMod), { headers: { "content-type": "application/json" } });
        }
        if (path.endsWith("/invoke")) {
          return new Response(JSON.stringify({ ok: true, output: { project: "film", keyframes } }), {
            headers: { "content-type": "application/json" },
          });
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
      async head() { return null; },
      async list() { return { objects: [] }; },
    },
  };
}

const kf = (n: number, reused?: unknown) => ({
  shot_id: `shot_0${n}`,
  keyframe_key: `renders/film/keyframes/shot_0${n}.png`,
  ...(reused === undefined ? {} : { reused }),
});

async function previewWith(keyframes: unknown[]): Promise<FilmJob> {
  return startFilmJob(envReturning(keyframes) as never, {
    project: "film",
    bundle_key: "bundles/x.tar.gz",
    scenes: [1, 2, 3].map((n) => ({ shot_id: `shot_0${n}`, prompt: `s${n}`, seconds: 4 })),
    keyframe_backend: "keyframe",
    motion_backend: "cf-seedance",
    keyframes_only: true,
  });
}

describe("reused: the backend mark reaches the job doc and the render payload", () => {
  it("carries a reused still to output.keyframe_reuse and onto its keyframe entry", async () => {
    const job = await previewWith([kf(1, true), kf(2), kf(3, true)]);
    expect(job.phase).toBe("done");
    expect(job.keyframes?.map((k) => k.reused)).toEqual([true, undefined, true]);
    const out = filmDonePayload(job, null);
    expect(out.keyframe_reuse).toEqual({ stills: 3, reused: ["shot_01", "shot_03"] });
    const entries = out.keyframes as Array<Record<string, unknown>>;
    expect(entries[0].reused).toBe(true);
    expect("reused" in entries[1]).toBe(false);
    expect(entries[2].reused).toBe(true);
  });

  it("a render that drew every still has no keyframe_reuse key", async () => {
    const out = filmDonePayload(await previewWith([kf(1), kf(2), kf(3)]), null);
    expect("keyframe_reuse" in out).toBe(false);
    const fresh = filmDonePayload(await previewWith([kf(1, false), kf(2), kf(3)]), null);
    expect("keyframe_reuse" in fresh).toBe(false);
  });

  it("only a JSON true is the mark: an odd value claims no reuse and keeps the still", async () => {
    const job = await previewWith([kf(1, "true"), kf(2, 1), kf(3, { reused: true })]);
    expect(job.phase).toBe("done");
    expect(job.keyframes?.map((k) => k.reused)).toEqual([undefined, undefined, undefined]);
    expect("keyframe_reuse" in filmDonePayload(job, null)).toBe(false);
  });

  it("a film animated from a preview keeps the mark on the still it carried", async () => {
    const door = {
      name: "seedance", version: "0.1.0", api: "vivijure-module/2" as const, binding: "MODULE_SEEDANCE",
      hooks: ["motion.backend" as const], config_schema: {}, ui: { section: "motion", order: 6, locality: "cloud" as const },
    } as unknown as RegisteredModule;
    const docs = new Map<string, string>();
    const env = {
      PRESIGNER: {
        presignGet: async (key: string) => `https://example.invalid/${key}`,
        presignPut: async (key: string) => `https://example.invalid/${key}`,
      },
      MODULE_SEEDANCE: {
        fetch: async () => new Response(JSON.stringify({ ok: true, pending: true, poll: "p" }), {
          headers: { "content-type": "application/json" },
        }),
      },
      R2_RENDERS: {
        async put(key: string, value: string) { docs.set(key, value); },
        async get(key: string) {
          const v = docs.get(key);
          return v === undefined ? null : { text: async () => v };
        },
      },
    };
    const job = await startFilmFromKeyframes(env as never, {
      project: "film",
      bundle_key: "bundles/x.tar.gz",
      scenes: [1, 2].map((n) => ({ shot_id: `shot_0${n}`, prompt: `s${n}`, seconds: 4 })),
      keyframes: [
        { shot_id: "shot_01", keyframe_key: "renders/film/keyframes/shot_01.png", reused: true },
        { shot_id: "shot_02", keyframe_key: "renders/film/keyframes/shot_02.png" },
      ],
      motion_backend: "seedance",
      derive_mode: "finalized",
    }, [door]);
    expect(job.phase).toBe("clips");
    expect(job.keyframes?.map((k) => k.reused)).toEqual([true, undefined]);
  });

  it("the render row keeps the mark when it normalizes output.keyframes", () => {
    const refs = normalizeKeyframes([
      { shot_id: "shot_01", key: "k1", reused: true },
      { shot_id: "shot_02", key: "k2", reused: "yes" },
      { shot_id: "shot_03", key: "k3" },
    ]);
    expect(refs).toEqual([
      { shot_id: "shot_01", key: "k1", reused: true },
      { shot_id: "shot_02", key: "k2" },
      { shot_id: "shot_03", key: "k3" },
    ]);
  });
});

describe("keyframeReuseView", () => {
  it("is undefined when nothing was reused or there are no stills", () => {
    expect(keyframeReuseView(undefined)).toBeUndefined();
    expect(keyframeReuseView([])).toBeUndefined();
    expect(keyframeReuseView([{ shot_id: "a" }, { shot_id: "b", reused: false }])).toBeUndefined();
  });

  it("a job doc read back from R2 with an odd value claims no reuse", () => {
    const fromJson = JSON.parse('[{"shot_id":"a","reused":"yes"},{"shot_id":"b","reused":1}]');
    expect(keyframeReuseView(fromJson)).toBeUndefined();
  });

  it("names the reused stills in keyframe order and counts every still", () => {
    expect(keyframeReuseView([{ shot_id: "b", reused: true }, { shot_id: "a" }, { shot_id: "c", reused: true }]))
      .toEqual({ stills: 3, reused: ["b", "c"] });
  });
});
