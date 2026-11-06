import { describe, expect, it } from "vitest";
import { startFilmJob, type FilmJob } from "../src/film-orchestrator.js";
import { filmDonePayload } from "../src/render-output-payload.js";
import { normalizeKeyframes } from "../src/renders-db.js";
import { parsePlateCount, plateCheckView } from "../src/plate-count.js";
import type { RegisteredModule } from "../src/modules/types.js";

// The backend plate count guard (vivijure-backend 1.1.14) puts `plate_count` on each keyframe entry of
// a two-person shot. `clean: false` means the still was made from a plate that may still show an extra
// person. Before this change the core dropped the field at the job doc, so the studio could never say
// so: a guard that fails silently reads as a pass. These tests drive the REAL keyframe advance (a
// module invoke through startFilmJob) and read the job doc and the render payload it produces.

const UNCLEAN = { expected: 2, faces: [3, 3, 4], chosen: 0, clean: false, retries: 2 };
const CLEAN = { expected: 2, faces: [3, 2], chosen: 1, clean: true, retries: 2 };

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

const kf = (n: number, plate?: unknown) => ({
  shot_id: `shot_0${n}`,
  keyframe_key: `renders/film/keyframes/shot_0${n}.png`,
  ...(plate === undefined ? {} : { plate_count: plate }),
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

describe("plate_count: the module report reaches the job doc and the render payload", () => {
  it("carries an unclean still to output.plate_check and onto its keyframe entry", async () => {
    const job = await previewWith([kf(1, UNCLEAN), kf(2, CLEAN), kf(3)]);
    expect(job.phase).toBe("done");
    expect(job.keyframes?.[0].plate_count).toEqual(UNCLEAN);
    expect(job.keyframes?.[2].plate_count).toBeUndefined();
    const out = filmDonePayload(job, null);
    expect(out.plate_check).toEqual({ checked: 2, unclean: [{ shot_id: "shot_01", expected: 2, faces: 3 }] });
    const entries = out.keyframes as Array<Record<string, unknown>>;
    expect(entries[0].plate_count).toEqual(UNCLEAN);
    expect(entries[1].plate_count).toEqual(CLEAN);
    expect("plate_count" in entries[2]).toBe(false);
  });

  it("RAN CLEAN is unclean: [], which is not the same as never having run", async () => {
    const clean = filmDonePayload(await previewWith([kf(1, CLEAN), kf(2), kf(3)]), null);
    expect(clean.plate_check).toEqual({ checked: 1, unclean: [] });
    const never = filmDonePayload(await previewWith([kf(1), kf(2), kf(3)]), null);
    expect("plate_check" in never).toBe(false);
  });

  it("drops a malformed report instead of reading it as clean, and keeps the still", async () => {
    const job = await previewWith([kf(1, { ...UNCLEAN, clean: "no" }), kf(2, "junk"), kf(3, { clean: false })]);
    expect(job.phase).toBe("done");
    expect(job.keyframes?.map((k) => k.plate_count)).toEqual([undefined, undefined, undefined]);
    expect("plate_check" in filmDonePayload(job, null)).toBe(false);
  });

  it("the render row keeps the report when it normalizes output.keyframes", () => {
    const refs = normalizeKeyframes([
      { shot_id: "shot_01", key: "k1", plate_count: UNCLEAN },
      { shot_id: "shot_02", key: "k2", plate_count: { clean: true } },
      { shot_id: "shot_03", key: "k3" },
    ]);
    expect(refs).toEqual([
      { shot_id: "shot_01", key: "k1", plate_count: UNCLEAN },
      { shot_id: "shot_02", key: "k2" },
      { shot_id: "shot_03", key: "k3" },
    ]);
  });
});

describe("parsePlateCount / plateCheckView", () => {
  it("accepts the documented shape only", () => {
    expect(parsePlateCount(UNCLEAN)).toEqual(UNCLEAN);
    expect(parsePlateCount({ ...UNCLEAN, faces: [3, -1] })).toBeUndefined();
    expect(parsePlateCount({ ...UNCLEAN, expected: 2.5 })).toBeUndefined();
    expect(parsePlateCount([UNCLEAN])).toBeUndefined();
    expect(parsePlateCount(null)).toBeUndefined();
  });

  it("carries the backend face-floor flag, and only a literal true (vivijure-core#492)", () => {
    // The shape the hosted backend 1.1.18 returned on cf#1281 (RunPod job f551a6a6-...-u1).
    const FLOOR = { expected: 2, faces: [1, 1, 2], chosen: 2, clean: true, retries: 3, floor: true };
    expect(parsePlateCount(FLOOR)).toEqual(FLOOR);
    const { floor: _f, ...noFloor } = FLOOR;
    expect(parsePlateCount(noFloor)).toEqual(noFloor);
    expect(parsePlateCount(noFloor)).not.toHaveProperty("floor");
    expect(parsePlateCount({ ...noFloor, floor: false })).not.toHaveProperty("floor");
    expect(parsePlateCount({ ...noFloor, floor: "true" })).not.toHaveProperty("floor");
    expect(parsePlateCount({ ...noFloor, floor: 1 })).not.toHaveProperty("floor");
  });

  it("reports faces as null when chosen points outside the draws", () => {
    const v = plateCheckView([{ shot_id: "a", plate_count: { ...UNCLEAN, chosen: 9 } }]);
    expect(v).toEqual({ checked: 1, unclean: [{ shot_id: "a", expected: 2, faces: null }] });
  });

  it("is undefined when the guard ran on nothing", () => {
    expect(plateCheckView(undefined)).toBeUndefined();
    expect(plateCheckView([])).toBeUndefined();
    expect(plateCheckView([{ shot_id: "a" }])).toBeUndefined();
  });
});
