import { describe, expect, it } from "vitest";
import {
  advanceFilmJob,
  cancelInFlightKeyframe,
  partitionContiguous,
  resolveKeyframeParallel,
  startFilmJob,
  type FilmJob,
} from "../src/film-orchestrator.js";
import { filmJobDocKey } from "../src/film-model.js";
import type { RegisteredModule } from "../src/modules/types.js";

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

const SCENES = [1, 2, 3, 4, 5].map((n) => ({
  shot_id: `shot_0${n}`,
  prompt: `scene ${n}`,
  seconds: 4,
}));

function kfOut(shotIds: string[]) {
  return {
    project: "film",
    keyframes: shotIds.map((shot_id) => ({
      shot_id,
      keyframe_key: `renders/film/keyframes/${shot_id}.png`,
    })),
  };
}

interface InvokeRec {
  shot_ids: string[];
  pretrained_loras?: Record<string, string>;
}

function harness(opts: {
  keyframeParallel?: string;
  invoke?: (shotIds: string[], n: number) => unknown;
  poll?: (token: string, n: number) => unknown;
}) {
  const objects = new Map<string, string>();
  const invokes: InvokeRec[] = [];
  const polls: string[] = [];
  const cancels: string[] = [];
  let invokeN = 0;
  let pollN = 0;

  const env = {
    KEYFRAME_PARALLEL: opts.keyframeParallel,
    MODULE_KEYFRAME: {
      fetch: async (url: string, init?: RequestInit) => {
        const path = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (path.endsWith("/module.json")) {
          return new Response(JSON.stringify(kfMod), { headers: { "content-type": "application/json" } });
        }
        if (path.endsWith("/invoke")) {
          const input = (body.input ?? {}) as { shot_ids?: string[]; pretrained_loras?: Record<string, string> };
          invokes.push({ shot_ids: input.shot_ids ?? [], pretrained_loras: input.pretrained_loras });
          const n = invokeN++;
          const payload = opts.invoke
            ? opts.invoke(input.shot_ids ?? [], n)
            : { ok: true, pending: true, poll: `kf-poll-${n}`, jobId: `rp-${n}` };
          return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
        }
        if (path.endsWith("/poll")) {
          const token = String((body as { poll?: string }).poll ?? "");
          polls.push(token);
          const n = pollN++;
          const payload = opts.poll
            ? opts.poll(token, n)
            : { ok: true, pending: true, wait: "running" };
          return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
        }
        if (path.endsWith("/cancel")) {
          cancels.push(String((body as { poll?: string }).poll ?? ""));
          return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
        }
        return new Response("no", { status: 404 });
      },
    },
    R2_RENDERS: {
      async put(key: string, value: string) {
        objects.set(key, value);
      },
      async get(key: string) {
        const v = objects.get(key);
        if (v === undefined) return null;
        return { text: async () => v };
      },
      async list() {
        return { objects: [], truncated: false };
      },
    },
  };

  const read = (filmId: string): FilmJob => {
    const raw = objects.get(filmJobDocKey(filmId));
    if (raw === undefined) throw new Error("no film job persisted");
    return JSON.parse(raw) as FilmJob;
  };

  return { env: env as never, invokes, polls, cancels, read, objects };
}

const START = {
  project: "film",
  bundle_key: "bundles/film.tar.gz",
  scenes: SCENES,
  keyframes_only: true,
};

describe("resolveKeyframeParallel / partitionContiguous", () => {
  it("N = min(shotCount, max(1, parseInt(KEYFRAME_PARALLEL || 4)))", () => {
    expect(resolveKeyframeParallel(undefined, 5)).toBe(4);
    expect(resolveKeyframeParallel("2", 5)).toBe(2);
    expect(resolveKeyframeParallel("1", 5)).toBe(1);
    expect(resolveKeyframeParallel("99", 5)).toBe(5);
    expect(resolveKeyframeParallel("0", 5)).toBe(1);
    expect(resolveKeyframeParallel("nope", 5)).toBe(4);
    expect(resolveKeyframeParallel("2", 1)).toBe(1);
  });

  it("5 shots / 2 parts are contiguous and cover every shot", () => {
    const chunks = partitionContiguous(SCENES.map((s) => s.shot_id), 2);
    expect(chunks).toEqual([
      ["shot_01", "shot_02", "shot_03"],
      ["shot_04", "shot_05"],
    ]);
  });
});

describe("keyframe parallel start/advance", () => {
  it("5 shots / KEYFRAME_PARALLEL=2 starts 2 invokes and merges immediate outputs", async () => {
    const h = harness({
      keyframeParallel: "2",
      invoke: (shotIds) => ({ ok: true, output: kfOut(shotIds) }),
    });
    const job = await startFilmJob(h.env, START, [kfMod]);
    expect(h.invokes.map((i) => i.shot_ids)).toEqual([
      ["shot_01", "shot_02", "shot_03"],
      ["shot_04", "shot_05"],
    ]);
    expect(job.keyframe_poll).toBeUndefined();
    expect(job.keyframe_polls).toBeUndefined();
    expect(job.phase).toBe("done");
    expect((job.keyframes ?? []).map((k) => k.shot_id)).toEqual(SCENES.map((s) => s.shot_id));
  });

  it("5 shots / KEYFRAME_PARALLEL=2 parks both poll tokens, then merges on advance", async () => {
    const h = harness({
      keyframeParallel: "2",
      poll: (token) => {
        const chunk = token === "kf-poll-0"
          ? ["shot_01", "shot_02", "shot_03"]
          : ["shot_04", "shot_05"];
        return { ok: true, output: kfOut(chunk) };
      },
    });
    const started = await startFilmJob(h.env, START, [kfMod]);
    expect(h.invokes).toHaveLength(2);
    expect(started.phase).toBe("keyframe");
    expect(started.keyframe_poll).toBeUndefined();
    expect(started.keyframe_polls).toEqual(["kf-poll-0", "kf-poll-1"]);
    expect(started.keyframe_job_ids).toEqual(["rp-0", "rp-1"]);

    const advanced = await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(advanced).not.toBeNull();
    expect(h.polls).toEqual(["kf-poll-0", "kf-poll-1"]);
    const doc = h.read(started.film_id);
    expect(doc.phase).toBe("done");
    expect(doc.keyframe_polls).toBeUndefined();
    expect((doc.keyframes ?? []).map((k) => k.shot_id)).toEqual(SCENES.map((s) => s.shot_id));
  });

  it("N=1 keeps the single invoke + keyframe_poll path", async () => {
    const h = harness({ keyframeParallel: "1" });
    const job = await startFilmJob(h.env, START, [kfMod]);
    expect(h.invokes).toHaveLength(1);
    expect(h.invokes[0].shot_ids).toEqual(SCENES.map((s) => s.shot_id));
    expect(job.keyframe_poll).toBe("kf-poll-0");
    expect(job.keyframe_job_id).toBe("rp-0");
    expect(job.keyframe_polls).toBeUndefined();
    expect(job.phase).toBe("keyframe");
  });

  it("a still-pending sibling stays in keyframe and parks completed chunks", async () => {
    const h = harness({
      keyframeParallel: "2",
      poll: (token) => token === "kf-poll-0"
        ? { ok: true, output: kfOut(["shot_01", "shot_02", "shot_03"]) }
        : { ok: true, pending: true, wait: "running" },
    });
    const started = await startFilmJob(h.env, START, [kfMod]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    const doc = h.read(started.film_id);
    expect(doc.phase).toBe("keyframe");
    expect(doc.keyframe_polls).toEqual(["kf-poll-1"]);
    expect((doc.keyframe_partials ?? []).map((k) => k.shot_id)).toEqual(["shot_01", "shot_02", "shot_03"]);
  });

  it("any invoke failure fails the film and cancels accepted siblings", async () => {
    const h = harness({
      keyframeParallel: "2",
      invoke: (_ids, n) => n === 0
        ? { ok: true, pending: true, poll: "kf-poll-0", jobId: "rp-0" }
        : { ok: false, error: "gpu said no" },
    });
    const job = await startFilmJob(h.env, START, [kfMod]);
    expect(job.phase).toBe("failed");
    expect(job.error).toBe("gpu said no");
    expect(h.cancels).toEqual(["kf-poll-0"]);
  });

  it("cancelInFlightKeyframe cancels every parallel poll token", async () => {
    const h = harness({ keyframeParallel: "2" });
    const job = await startFilmJob(h.env, START, [kfMod]);
    expect(job.keyframe_polls).toHaveLength(2);
    await cancelInFlightKeyframe(h.env, job, [kfMod]);
    expect(h.cancels).toEqual(["kf-poll-0", "kf-poll-1"]);
  });
});
