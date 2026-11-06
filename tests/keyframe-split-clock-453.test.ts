// vivijure-core#453 (vivijure-cf#1122 stage 1): keyframe jobs are split by size, a film that would need
// one oversized job is refused before anything is bought, and the keyframe phase has a progress clock.
import { describe, expect, it, vi } from "vitest";

const yamlState = vi.hoisted(() => ({ value: "use_characters: []\n" as string | null }));
vi.mock("../src/bundle-storyboard.js", async (original) => ({
  ...(await original<typeof import("../src/bundle-storyboard.js")>()),
  readBundleStoryboardYaml: async () => yamlState.value,
}));

import { advanceFilmJob, startFilmJob, type FilmJob } from "../src/film-orchestrator.js";
import {
  ceilingAgeSeconds,
  filmJobDocKey,
  filmProgressMarker,
  KEYFRAME_SHOTS_PER_JOB,
  PHASE_HARD_DEADLINE_SECONDS,
  resolveKeyframeJobs,
} from "../src/film-model.js";

const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const scenes = (n: number) =>
  Array.from({ length: n }, (_u, i) => ({ shot_id: `shot_${String(i + 1).padStart(3, "0")}`, prompt: `p${i}`, seconds: 6 }));

function harness(opts: { trains?: boolean; parallel?: string; listKeys?: string[] } = {}) {
  const objects = new Map<string, string>();
  const invokes: string[][] = [];
  const manifest = {
    name: "keyframe", version: "0.1.0", api: "vivijure-module/2", binding: "MODULE_KEYFRAME",
    hooks: ["keyframe"], config_schema: {}, ui: { section: "keyframe", order: 10 }, cancelable: true,
    ...(opts.trains ? { trains_loras: true } : {}),
  };
  const env = {
    KEYFRAME_PARALLEL: opts.parallel ?? "4",
    MODULE_KEYFRAME: {
      fetch: async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const path = String(url);
        if (path.endsWith("/module.json")) return json(manifest);
        if (path.endsWith("/invoke")) {
          invokes.push(body.input?.shot_ids ?? []);
          return json({ ok: true, pending: true, poll: `kf-poll-${invokes.length - 1}`, jobId: `rp-${invokes.length - 1}` });
        }
        if (path.endsWith("/poll")) return json({ ok: true, pending: true, wait: "running" });
        if (path.endsWith("/cancel")) return json({ ok: true });
        return new Response("no", { status: 404 });
      },
    },
    R2_RENDERS: {
      async put(k: string, v: string) { objects.set(k, v); },
      async get(k: string) { const v = objects.get(k); return v === undefined ? null : { text: async () => v }; },
      async list() { return { objects: (opts.listKeys ?? []).map((key) => ({ key, uploaded: new Date() })), truncated: false }; },
    },
  };
  const read = (id: string) => JSON.parse(objects.get(filmJobDocKey(id))!) as FilmJob;
  const write = (job: FilmJob) => objects.set(filmJobDocKey(job.film_id), JSON.stringify(job));
  return { env: env as never, invokes, read, write };
}

const start = (env: never, n: number, pretrained?: Record<string, string>) =>
  startFilmJob(env, { project: "film", bundle_key: "bundles/film.tar.gz", scenes: scenes(n), keyframes_only: true, pretrained_loras: pretrained } as never);

describe("resolveKeyframeJobs", () => {
  it("KEYFRAME_PARALLEL is the floor and the film's size sets the rest", () => {
    expect(resolveKeyframeJobs(undefined, 450)).toBe(8);
    expect(resolveKeyframeJobs("4", 240)).toBe(4);
    expect(resolveKeyframeJobs("4", 241)).toBe(5);
    expect(resolveKeyframeJobs("8", 100)).toBe(8);
    expect(resolveKeyframeJobs("1", 61)).toBe(2);
    expect(resolveKeyframeJobs("4", 3)).toBe(3);
    expect(resolveKeyframeJobs("4", 1)).toBe(1);
    expect(resolveKeyframeJobs("4", 0)).toBe(1);
  });
  it("no job carries more than KEYFRAME_SHOTS_PER_JOB shots, for every size up to 2000", () => {
    for (let s = 1; s <= 2000; s++) {
      const n = resolveKeyframeJobs("4", s);
      expect(Math.ceil(s / n)).toBeLessThanOrEqual(KEYFRAME_SHOTS_PER_JOB);
    }
  });
});

describe("a long film starts its keyframes split by size (vivijure-core#453)", () => {
  it("450 shots start 8 jobs, none over the limit, every shot once", async () => {
    yamlState.value = "use_characters: []\n";
    const h = harness();
    const job = await start(h.env, 450);
    expect(job.phase).toBe("keyframe");
    expect(h.invokes).toHaveLength(8);
    expect(Math.max(...h.invokes.map((c) => c.length))).toBeLessThanOrEqual(KEYFRAME_SHOTS_PER_JOB);
    const all = h.invokes.flat();
    expect(all).toHaveLength(450);
    expect(new Set(all).size).toBe(450);
  });

  it("a film forced to one job with more shots than one job carries is refused, and nothing is bought", async () => {
    yamlState.value = "use_characters: [A]\n";
    const h = harness({ trains: true });
    const job = await start(h.env, KEYFRAME_SHOTS_PER_JOB + 1);
    expect(job.phase).toBe("failed");
    expect(job.error).toMatch(/61 shots/);
    expect(job.error).toMatch(/no adapter is trained for A/);
    expect(job.error).toMatch(/at most 60 shots/);
    expect(h.invokes).toHaveLength(0);
  });

  it("CONTROL: at exactly the limit the forced single job still runs", async () => {
    yamlState.value = "use_characters: [A]\n";
    const h = harness({ trains: true });
    const job = await start(h.env, KEYFRAME_SHOTS_PER_JOB);
    expect(job.phase).toBe("keyframe");
    expect(h.invokes).toHaveLength(1);
    expect(h.invokes[0]).toHaveLength(KEYFRAME_SHOTS_PER_JOB);
  });

  it("CONTROL: with every adapter present the same long film splits and runs", async () => {
    yamlState.value = "use_characters: [A]\n";
    const h = harness({ trains: true });
    const job = await start(h.env, 120, { A: "loras/a.safetensors" });
    expect(job.phase).toBe("keyframe");
    expect(h.invokes).toHaveLength(4);
  });
});

describe("the keyframe phase has a progress clock (vivijure-core#453)", () => {
  const kfJob = (over: Partial<FilmJob>): FilmJob => ({ phase: "keyframe", created_at: 0, ...over } as FilmJob);

  it("the marker counts the stills parked from finished jobs", () => {
    expect(filmProgressMarker(kfJob({}), null)).toBe("keyframe:0:0");
    expect(filmProgressMarker(kfJob({ keyframe_partials: [{ shot_id: "a", keyframe_key: "k" }] } as Partial<FilmJob>), null)).toBe("keyframe:1:0");
  });

  it("the ceiling age runs from the last landed job, not from the phase start", () => {
    const now = 10_000_000;
    const job = kfJob({ phase_started_at: now - 100 * 60_000, last_progress_at: now - 5 * 60_000 });
    expect(ceilingAgeSeconds(job, now)).toBe(300);
  });

  async function agedFilm(progressMinutesAgo: number) {
    yamlState.value = "use_characters: []\n";
    const h = harness({ parallel: "2", listKeys: ["renders/film/keyframes/shot_001.png"] });
    const job = await start(h.env, 4);
    const old = Date.now() - (PHASE_HARD_DEADLINE_SECONDS + 600) * 1000;
    const partials = [{ shot_id: "shot_001", keyframe_key: "renders/film/keyframes/shot_001.png" }];
    const aged = { ...job, created_at: old, phase_started_at: old, keyframe_partials: partials } as FilmJob;
    aged.progress_marker = filmProgressMarker(aged, null);
    aged.last_progress_at = Date.now() - progressMinutesAgo * 60_000;
    h.write(aged);
    const r = await advanceFilmJob(h.env, job.film_id, undefined);
    return r?.job;
  }

  it("a pass past 90 min from its start whose last job landed 5 min ago keeps running", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const job = await agedFilm(5);
    expect(job?.phase).toBe("keyframe");
  });

  it("CONTROL: the same pass with no job landing in 90 min still fails at the ceiling", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const job = await agedFilm(PHASE_HARD_DEADLINE_SECONDS / 60 + 5);
    expect(job?.phase).toBe("failed");
    expect(job?.error).toMatch(/incomplete film -- keyframes/);
  });
});
