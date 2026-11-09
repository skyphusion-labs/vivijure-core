// core#493: a pending keyframe poll waits before it adopts the R2 set, so a finished job keeps its output.
//
// The backend writes each PNG to R2 BEFORE its job returns. So a healthy job always has a window where
// R2 holds the full set and RunPod still says IN_PROGRESS. The pending-poll adopt (#129 sibling, for a
// frozen envelope) ran on the first poll in that window: it cancelled a job that had finished and lost
// everything only in the job output. Measured on vivijure-core#493: job 2092b5e5-...-u1 was CANCELLED at
// RunPod with a full output carrying plate_count, and the studio row had no plate_count.
//
// Now the first pending poll that sees the full set stamps keyframe_r2_full_at and holds. The adopt runs
// on a later pending poll once KEYFRAME_R2_ADOPT_GRACE_SECONDS have passed. And an adopt keeps the
// outputs of jobs that already returned (the parallel path parks them), instead of the bare R2 keys.

import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceFilmJob, pendingKeyframeAdoptDue, startFilmJob, type FilmJob } from "../src/film-orchestrator.js";
import { filmJobDocKey, KEYFRAME_R2_ADOPT_GRACE_SECONDS } from "../src/film-model.js";
import type { RegisteredModule } from "../src/modules/types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const kfMod = {
  name: "keyframe",
  version: "0.1.0",
  api: "vivijure-module/2" as const,
  binding: "MODULE_KEYFRAME",
  hooks: ["keyframe" as const],
  config_schema: {},
  ui: { section: "keyframe", order: 10 },
  cancelable: true,
} as unknown as RegisteredModule;

const SHOTS = ["shot_01", "shot_02", "shot_03", "shot_04"];
const SCENES = SHOTS.map((shot_id, i) => ({ shot_id, prompt: `scene ${i}`, seconds: 4 }));
const PLATE = { expected: 2, faces: [2], chosen: 0, clean: true, retries: 3, floor: true };
const key = (s: string) => `renders/film/keyframes/${s}.png`;

function kfOut(shotIds: string[], withPlate: boolean) {
  return {
    project: "film",
    keyframes: shotIds.map((shot_id) => ({
      shot_id,
      keyframe_key: key(shot_id),
      ...(withPlate ? { plate_count: PLATE } : {}),
    })),
  };
}

/** A keyframe module behind a fetch stub, and an R2 whose listing the test controls. */
function harness(opts: { parallel: string; poll: (token: string) => unknown; inR2: () => string[] }) {
  const objects = new Map<string, string>();
  const cancels: string[] = [];
  let invokeN = 0;
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const env = {
    KEYFRAME_PARALLEL: opts.parallel,
    MODULE_KEYFRAME: {
      fetch: async (url: string, init?: RequestInit) => {
        const path = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) as { poll?: string } : {};
        if (path.endsWith("/module.json")) return json(kfMod);
        if (path.endsWith("/invoke")) { const n = invokeN++; return json({ ok: true, pending: true, poll: `kf-poll-${n}`, jobId: `rp-${n}` }); }
        if (path.endsWith("/poll")) return json(opts.poll(String(body.poll ?? "")));
        if (path.endsWith("/cancel")) { cancels.push(String(body.poll ?? "")); return json({ ok: true }); }
        return new Response("no", { status: 404 });
      },
    },
    R2_RENDERS: {
      async put(k: string, v: string) { objects.set(k, v); },
      async get(k: string) { const v = objects.get(k); return v === undefined ? null : { text: async () => v }; },
      async list() { return { objects: opts.inR2().map((k) => ({ key: k, uploaded: new Date() })), truncated: false }; },
    },
  };
  const read = (id: string) => JSON.parse(objects.get(filmJobDocKey(id))!) as FilmJob;
  return { env: env as never, cancels, read };
}

const START = { project: "film", bundle_key: "bundles/film.tar.gz", scenes: SCENES, keyframes_only: true };
const T0 = Date.UTC(2026, 10, 6, 23, 25, 0);
const GRACE = KEYFRAME_R2_ADOPT_GRACE_SECONDS * 1000;

function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  return (ms: number) => vi.setSystemTime(T0 + ms);
}

describe("pendingKeyframeAdoptDue", () => {
  it("stamps on first sight and holds; adopts only once the grace has passed", () => {
    const job = { keyframe_r2_full_at: undefined } as FilmJob;
    expect(pendingKeyframeAdoptDue(job, T0)).toBe(false);
    expect(job.keyframe_r2_full_at).toBe(T0);
    expect(pendingKeyframeAdoptDue(job, T0 + GRACE - 1)).toBe(false);
    expect(pendingKeyframeAdoptDue(job, T0 + GRACE)).toBe(true);
  });
});

describe("a pending poll with the full set in R2 (core#493)", () => {
  it("does not cancel a job that is about to return; its output, plate count and all, is kept", async () => {
    const at = clock();
    let returned = false;
    const h = harness({
      parallel: "1",
      poll: () => (returned ? { ok: true, output: kfOut(SHOTS, true) } : { ok: true, pending: true, wait: "running" }),
      inR2: () => SHOTS.map(key), // every PNG is in R2 before the job returns
    });
    const job = await startFilmJob(h.env, START, [kfMod]);
    await advanceFilmJob(h.env, job.film_id, [kfMod]); // the window: R2 full, RunPod IN_PROGRESS
    let doc = h.read(job.film_id);
    expect(h.cancels).toEqual([]);
    expect(doc.phase).toBe("keyframe");
    expect(doc.keyframe_r2_full_at).toBe(T0);

    at(30_000);
    returned = true; // the job returns inside the grace
    await advanceFilmJob(h.env, job.film_id, [kfMod]);
    doc = h.read(job.film_id);
    expect(h.cancels).toEqual([]);
    expect(doc.phase).toBe("done");
    expect(doc.keyframe_recovered).toBeUndefined();
    expect(doc.keyframe_r2_full_at).toBeUndefined();
    expect(doc.keyframes?.map((k) => k.plate_count)).toEqual(SHOTS.map(() => PLATE));
  });

  it("a frozen envelope is still adopted, once the grace has passed", async () => {
    const at = clock();
    const h = harness({ parallel: "1", poll: () => ({ ok: true, pending: true, wait: "running" }), inR2: () => SHOTS.map(key) });
    const job = await startFilmJob(h.env, START, [kfMod]);
    await advanceFilmJob(h.env, job.film_id, [kfMod]);
    at(GRACE - 1_000);
    await advanceFilmJob(h.env, job.film_id, [kfMod]);
    expect(h.cancels).toEqual([]);
    expect(h.read(job.film_id).phase).toBe("keyframe");

    at(GRACE);
    await advanceFilmJob(h.env, job.film_id, [kfMod]);
    const doc = h.read(job.film_id);
    expect(h.cancels).toEqual(["kf-poll-0"]);
    expect(doc.phase).toBe("done");
    expect(doc.keyframe_recovered).toBe(true);
    expect(doc.keyframes?.map((k) => k.shot_id)).toEqual(SHOTS);
  });

  it("an adopt keeps the output of a sibling job that already returned", async () => {
    const at = clock();
    const h = harness({
      parallel: "2",
      // kf-poll-0 returned shots 1 and 2 with their records; kf-poll-1 is frozen.
      poll: (t) => (t === "kf-poll-0" ? { ok: true, output: kfOut(["shot_01", "shot_02"], true) } : { ok: true, pending: true, wait: "running" }),
      inR2: () => SHOTS.map(key),
    });
    const job = await startFilmJob(h.env, START, [kfMod]);
    await advanceFilmJob(h.env, job.film_id, [kfMod]);
    expect(h.read(job.film_id).keyframe_partials?.map((k) => k.shot_id)).toEqual(["shot_01", "shot_02"]);
    at(GRACE);
    await advanceFilmJob(h.env, job.film_id, [kfMod]);
    const doc = h.read(job.film_id);
    expect(h.cancels).toEqual(["kf-poll-1"]);
    expect(doc.phase).toBe("done");
    const plate = Object.fromEntries((doc.keyframes ?? []).map((k) => [k.shot_id, k.plate_count]));
    expect(plate).toEqual({ shot_01: PLATE, shot_02: PLATE, shot_03: undefined, shot_04: undefined });
  });

  it("a partial set never starts the grace", async () => {
    clock();
    const h = harness({ parallel: "1", poll: () => ({ ok: true, pending: true }), inR2: () => [key("shot_01"), key("shot_02")] });
    const job = await startFilmJob(h.env, START, [kfMod]);
    await advanceFilmJob(h.env, job.film_id, [kfMod]);
    const doc = h.read(job.film_id);
    expect(doc.keyframe_r2_full_at).toBeUndefined();
    expect(doc.phase).toBe("keyframe");
    expect(h.cancels).toEqual([]);
  });
});
