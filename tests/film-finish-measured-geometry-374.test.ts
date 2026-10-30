/// <reference types="node" />
// core#374: assemble already delivers at the measured clip geometry. film.finish and
// per-shot finish still seeded resolveDeliveryResolution, which is 1920x1080 when the
// job has no delivery_width. A 720x1280 assemble was then pillarboxed.
//
// The asserted size is NOT 1920x1080. A test written against the default would stay
// green if the seed forgot the measurement and fell back.

import { describe, expect, it } from "vitest";
import { advanceFilmJob, clipJobDocKey, filmJobDocKey, runFilmFinish } from "../src/film-orchestrator.js";
import { DEFAULT_DELIVERY_HEIGHT, DEFAULT_DELIVERY_WIDTH } from "../src/film-model.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import { MODULE_API, type RegisteredModule } from "../src/modules/types.js";

const FILM_KEY = "renders/p1/film.mp4";
const CLIP_JOB = "cj-374";
const VERT = { width: 720, height: 1280 };

const TITLES: RegisteredModule = {
  name: "film-titles",
  version: "0.1.0",
  api: "vivijure-module/2",
  hooks: ["film.finish"],
  ui: { section: "finish", order: 10 },
  binding: "MODULE_FILM_TITLES",
} as unknown as RegisteredModule;

const clipDoc = {
  job_id: CLIP_JOB,
  shots: [{ shot_id: "a", status: "done", delivered_width: VERT.width, delivered_height: VERT.height }],
};

function envCapturing(seen: Record<string, unknown>[]) {
  const clipKey = clipJobDocKey(CLIP_JOB);
  return {
    R2_RENDERS: {
      head: async () => null,
      get: async (key: string) => {
        if (key !== clipKey) return null;
        return { text: async () => JSON.stringify(clipDoc) };
      },
      put: async () => undefined,
    },
    PRESIGNER: {
      presignGet: async (k: string) => `https://g/${k}`,
      presignPut: async (k: string) => `https://p/${k}`,
    },
    MODULE_FILM_TITLES: {
      fetch: async (_u: unknown, init: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { input?: Record<string, unknown> };
        if (body.input) seen.push(body.input);
        return new Response(JSON.stringify({ ok: true, output: { film_key: FILM_KEY, applied: [] } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    },
  } as unknown as Env;
}

const base = {
  film_key: FILM_KEY,
  scenes: [],
  bundle_key: "bundles/p1.tar.gz",
  project: "p1",
  job_id: "j1",
  clip_job_id: CLIP_JOB,
};

describe("core#374: film.finish is seeded with the assembled geometry", () => {
  it("a 720x1280 assemble seeds film.finish with 720x1280", async () => {
    const seen: Record<string, unknown>[] = [];
    await runFilmFinish(envCapturing(seen), base, [TITLES]);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].width).toBe(720);
    expect(seen[0].height).toBe(1280);
    expect(seen[0].width).not.toBe(DEFAULT_DELIVERY_WIDTH);
    expect(seen[0].height).not.toBe(DEFAULT_DELIVERY_HEIGHT);
  });

  it("an operator target still wins over the 720x1280 measurement", async () => {
    const seen: Record<string, unknown>[] = [];
    await runFilmFinish(
      envCapturing(seen),
      { ...base, delivery_width: 1920, delivery_height: 1080 },
      [TITLES],
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].width).toBe(1920);
    expect(seen[0].height).toBe(1080);
  });
});

describe("core#374: per-shot finish keeps its delivery target", () => {
  it("the measured size is not sent as the target, since upscale would then pay to change nothing", async () => {
    const FILM = "film-374-vert";
    const seen: Record<string, unknown>[] = [];
    const job = {
      film_id: FILM,
      project: "p",
      bundle_key: "bundles/p.tar.gz",
      scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
      motion_backend: "own-gpu",
      motion_config: {},
      finish_config: {},
      keyframe_binding: null,
      phase: "clips",
      clip_job_id: CLIP_JOB,
      created_at: 0,
    };
    const store = new Map<string, string>([
      [filmJobDocKey(FILM), JSON.stringify(job)],
      [clipJobDocKey(CLIP_JOB), JSON.stringify({
        job_id: CLIP_JOB,
        project: "p",
        shots: [{
          shot_id: "shot_01",
          status: "done",
          clip_key: "renders/" + FILM + "/shot_01.mp4",
          delivered_width: VERT.width,
          delivered_height: VERT.height,
        }],
      })],
    ]);
    const jsonResp = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const manifest = {
      name: "finish-rife",
      version: "1.0.0",
      api: MODULE_API,
      hooks: ["finish"],
      ui: { order: 10, section: "finish" },
    };
    const env: Record<string, unknown> = {
      R2_RENDERS: {
        get: async (key: string) => {
          const v = store.get(key);
          return v === undefined ? null : { text: async () => v };
        },
        head: async () => null,
        list: async () => ({ objects: [] }),
        put: async (key: string, val: string) => { store.set(key, val); },
      },
      PRESIGNER: {
        presignGet: async (k: string) => "https://presigned/" + k,
        presignPut: async (k: string) => "https://presigned-put/" + k,
      },
      MODULE_FINISH_RIFE: {
        fetch: async (url: string, init?: { body?: string }) => {
          if (String(url).endsWith("/module.json")) return jsonResp(manifest);
          const body = JSON.parse(init?.body ?? "{}") as { input?: Record<string, unknown> };
          if (body.input) seen.push(body.input);
          return jsonResp({ ok: true, pending: true, poll: "tok" });
        },
      },
    };

    await advanceFilmJob(env as unknown as Env, FILM);

    expect(seen.length, "DENOMINATOR: the finish module was invoked").toBeGreaterThan(0);
    expect(seen[0].delivery_width).toBe(DEFAULT_DELIVERY_WIDTH);
    expect(seen[0].delivery_height).toBe(DEFAULT_DELIVERY_HEIGHT);
    // The source hints still ride along, measured, so the module knows what it was given.
    expect(seen[0].width).toBe(720);
    expect(seen[0].height).toBe(1280);
  });
});
