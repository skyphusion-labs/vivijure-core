import { describe, expect, it } from "vitest";
import {
  advanceFilmJob,
  cancelFilmJob,
  cancelInFlightKeyframe,
  partitionContiguous,
  resolveFilmFrame,
  resolveKeyframeParallel,
  startFilmJob,
  type FilmJob,
} from "../src/film-orchestrator.js";
import { clipJobDocKey, filmJobDocKey, PHASE_HARD_DEADLINE_SECONDS } from "../src/film-model.js";
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
  listKeys?: string[];
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
          if (payload instanceof Response) return payload;
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
        return {
          objects: (opts.listKeys ?? []).map((key) => ({ key, uploaded: new Date() })),
          truncated: false,
        };
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

  it("does not fail-close when a chunk reports a banked Cast LoRA under loras/", async () => {
    const h = harness({
      keyframeParallel: "2",
      invoke: (shotIds) => ({
        ok: true,
        output: {
          ...kfOut(shotIds),
          trained_loras: { A: "loras/wren.safetensors" },
        },
      }),
    });
    const job = await startFilmJob(h.env, START, [kfMod]);
    expect(job.phase).toBe("done");
    expect(job.error).toBeUndefined();
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

  it("a film failing at the ceiling with a partial set stops the keyframe jobs still running", async () => {
    const h = harness({
      keyframeParallel: "2",
      listKeys: ["renders/neon/keyframes/shot_01.png"],
    });
    const job = await startFilmJob(h.env, START, [kfMod]);
    const old = Date.now() - (PHASE_HARD_DEADLINE_SECONDS + 60) * 1000;
    await (h.env as unknown as { R2_RENDERS: { put(k: string, v: string): Promise<void> } }).R2_RENDERS.put(
      filmJobDocKey(job.film_id),
      JSON.stringify({ ...job, created_at: old, phase_started_at: old }),
    );
    const r = await advanceFilmJob(h.env, job.film_id, [kfMod]);
    expect(r?.job.phase).toBe("failed");
    expect(r?.job.error).toMatch(/incomplete film -- keyframes/);
    expect(h.cancels).toEqual(["kf-poll-0", "kf-poll-1"]);
  });
});

describe("a keyframe poll that fails in transport", () => {
  const five = () => new Response("boom", { status: 500 });
  const pending = { ok: true, pending: true, wait: "running" };

  it("one 500 on a sibling keeps the film, the token and the other's output", async () => {
    const h = harness({
      keyframeParallel: "2",
      poll: (token) => token === "kf-poll-0" ? { ok: true, output: kfOut(["shot_01", "shot_02", "shot_03"]) } : five(),
    });
    const started = await startFilmJob(h.env, START, [kfMod]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    const doc = h.read(started.film_id);
    expect(doc.phase).toBe("keyframe");
    expect(doc.keyframe_polls).toEqual(["kf-poll-1"]);
    expect(doc.keyframe_job_ids).toEqual(["rp-1"]);
    expect(doc.keyframe_poll_attempts).toBe(1);
    expect((doc.keyframe_partials ?? []).map((k) => k.shot_id)).toEqual(["shot_01", "shot_02", "shot_03"]);
    expect(h.cancels).toEqual([]);
  });

  it("three ticks in a row fail the film by name and stop its jobs", async () => {
    const h = harness({ keyframeParallel: "2", poll: () => five() });
    const started = await startFilmJob(h.env, START, [kfMod]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).phase).toBe("keyframe");
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    const doc = h.read(started.film_id);
    expect(doc.phase).toBe("failed");
    expect(doc.error).toMatch(/module \/poll -> 500.*persisted through 3 consecutive polls/);
    expect(h.cancels.length).toBeGreaterThan(0);
  });

  it("a clean tick resets the count", async () => {
    let tick = 0;
    const h = harness({ keyframeParallel: "1", poll: () => { tick += 1; return tick % 3 === 0 ? pending : five(); } });
    const started = await startFilmJob(h.env, START, [kfMod]);
    for (let i = 0; i < 8; i++) await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).phase).toBe("keyframe");
  });

  it("a clean parallel tick resets the count", async () => {
    let tick = 0;
    const h = harness({ keyframeParallel: "2", poll: () => { tick += 1; return tick % 6 < 4 && tick % 6 > 0 ? five() : pending; } });
    const started = await startFilmJob(h.env, START, [kfMod]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).keyframe_poll_attempts).toBe(1);
    for (let i = 0; i < 2; i++) await advanceFilmJob(h.env, started.film_id, [kfMod]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).phase).toBe("keyframe");
    expect(h.read(started.film_id).keyframe_polls?.length).toBe(2);
  });

  it("the single-job path tolerates the same and fails at three", async () => {
    const h = harness({ keyframeParallel: "1", poll: () => five() });
    const started = await startFilmJob(h.env, START, [kfMod]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    const mid = h.read(started.film_id);
    expect(mid.phase).toBe("keyframe");
    expect(mid.keyframe_poll).toBe("kf-poll-0");
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).error).toMatch(/persisted through 3/);
    expect(h.cancels).toEqual(["kf-poll-0"]);
  });

  it("a dead job is not a transport failure: waiting would never recover it", async () => {
    const h = harness({ keyframeParallel: "1", poll: () => ({ ok: false, error: "provider job died: high load (7003)" }) });
    const started = await startFilmJob(h.env, START, [kfMod]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).phase).toBe("failed");
    expect(h.cancels).toEqual(["kf-poll-0"]);
  });

  for (const parallel of ["1", "2"]) {
    it(`a real failure a module reports still fails at once (parallel ${parallel})`, async () => {
      const h = harness({ keyframeParallel: parallel, poll: () => ({ ok: false, error: "keyframe: bad LoRA" }) });
      const started = await startFilmJob(h.env, START, [kfMod]);
      await advanceFilmJob(h.env, started.film_id, [kfMod]);
      const doc = h.read(started.film_id);
      expect(doc.phase).toBe("failed");
      expect(doc.error).toBe("keyframe: bad LoRA");
    });
  }
});

describe("a film start keeps the frame it was asked for", () => {
  it("is on the job, and the film is delivered at it", async () => {
    const h = harness({ keyframeParallel: "1" });
    const started = await startFilmJob(h.env, { ...START, delivery_width: 1920, delivery_height: 1080 }, [kfMod]);
    const doc = h.read(started.film_id);
    expect([doc.delivery_width, doc.delivery_height]).toEqual([1920, 1080]);
    // Clips measured at another frame do not move it: this is what let parts on different doors differ.
    const frame = await resolveFilmFrame(h.env, { ...doc, assemble_frame: { width: 1936, height: 1080 } });
    expect(frame).toMatchObject({ width: 1920, height: 1080, decided: true });
  });

  it("CONTROL: with no frame asked for, none is invented, and measured clips decide", async () => {
    const h = harness({ keyframeParallel: "1" });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const doc = h.read(started.film_id);
    expect("delivery_width" in doc).toBe(false);
    const frame = await resolveFilmFrame(h.env, { ...doc, assemble_frame: { width: 1936, height: 1080 } });
    expect(frame).toMatchObject({ width: 1936, height: 1080 });
  });
});

describe("core#425 a failed film asks its GPU jobs to cancel", () => {
  const pending = { ok: true, pending: true, wait: "running" };
  const stmt = { run: async () => ({ meta: { changes: 1 } }), first: async () => ({ one: 1 }), all: async () => ({ results: [] }) };
  const harnessWithDb = (opts: Parameters<typeof harness>[0]) => {
    const h = harness(opts);
    (h.env as unknown as { DB: unknown }).DB = { prepare: () => ({ ...stmt, bind: () => stmt }), batch: async () => [] };
    return h;
  };

  it("a throw in a tick stops every keyframe job, once", async () => {
    const h = harnessWithDb({ keyframeParallel: "2", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const r2 = (h.env as unknown as { R2_RENDERS: { list: () => Promise<unknown> } }).R2_RENDERS;
    r2.list = async () => { throw new Error("list: internal (10001)"); };
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    const doc = h.read(started.film_id);
    expect(doc.phase).toBe("failed");
    expect(doc.error).toMatch(/advance failed: list/);
    expect(doc.jobs_cancel_asked).toBe(true);
    expect([...h.cancels].sort()).toEqual(["kf-poll-0", "kf-poll-1"]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.cancels).toHaveLength(2);
  });

  it("a write that also fails does not hide the failure, or stop the cancels", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const r2 = (h.env as unknown as { R2_RENDERS: { list: () => Promise<unknown>; put: (k: string, v: string) => Promise<void> } }).R2_RENDERS;
    r2.list = async () => { throw new Error("list: internal (10001)"); };
    const put = r2.put.bind(r2);
    let puts = 0;
    r2.put = async (k, v) => { puts += 1; if (puts === 2) throw new Error("put: internal (10001)"); await put(k, v); };
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).phase).toBe("failed");
    expect(h.cancels).toEqual(["kf-poll-0"]);
  });

  it("a cancel that fails leaves the film failed for its own reason", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const env = h.env as unknown as { R2_RENDERS: { list: () => Promise<unknown> }; MODULE_KEYFRAME: { fetch: (u: string, i?: RequestInit) => Promise<Response> } };
    env.R2_RENDERS.list = async () => { throw new Error("list: internal (10001)"); };
    const fetcher = env.MODULE_KEYFRAME.fetch;
    env.MODULE_KEYFRAME.fetch = async (u, i) => { if (String(u).endsWith("/cancel")) throw new Error("no"); return fetcher(u, i); };
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).error).toMatch(/advance failed: list/);
  });

  it("a database that is also down does not stop the cancels", async () => {
    const h = harness({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const r2 = (h.env as unknown as { R2_RENDERS: { list: () => Promise<unknown> } }).R2_RENDERS;
    r2.list = async () => { throw new Error("list: internal (10001)"); };
    await advanceFilmJob(h.env, started.film_id, [kfMod]).catch(() => null);
    expect(h.cancels).toEqual(["kf-poll-0"]);
  });

  it("a film that fails without a throw stops its clip jobs too", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => ({ ok: false, error: "keyframe: bad LoRA" }) });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const doc = h.read(started.film_id);
    const clipDoc = { job_id: "clips-1", binding: "MODULE_KEYFRAME", motion_backend: "keyframe", shots: [{ shot_id: "shot_01", prompt: "a", seconds: 4, status: "pending", poll: "clip-poll-1" }] };
    h.objects.set(clipJobDocKey("clips-1"), JSON.stringify(clipDoc));
    h.objects.set(filmJobDocKey(started.film_id), JSON.stringify({ ...doc, clip_job_id: "clips-1" }));
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).jobs_cancel_asked).toBe(true);
    expect(h.cancels).toContain("clip-poll-1");
  });

  it("trouble while stopping does not change why the film failed", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => ({ ok: false, error: "keyframe: bad LoRA" }) });
    const started = await startFilmJob(h.env, START, [kfMod]);
    h.objects.set(clipJobDocKey("clips-1"), "{}");
    h.objects.set(filmJobDocKey(started.film_id), JSON.stringify({ ...h.read(started.film_id), clip_job_id: "clips-1" }));
    const r = await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(r?.job.error, "the tick reports the film, not a corrupt doc").toBe("keyframe: bad LoRA");
    expect(h.read(started.film_id).jobs_cancel_asked).toBe(true);
  });

  const finishDoc = (doc: FilmJob, over: object = {}) => ({
    ...doc, phase: "finish", keyframe_poll: undefined, keyframe_polls: undefined,
    finish_shots: [{ shot_id: "shot_01", clip_key: "renders/film/clips/a.mp4", chain: ["MODULE_KEYFRAME"], configs: [{}], idx: 0, status: "pending", applied: [], poll: "fs-1" }],
    ...over,
  });
  const failNextDocWrite = (h: ReturnType<typeof harnessWithDb>, filmId: string) => {
    const r2 = (h.env as unknown as { R2_RENDERS: { put: (k: string, v: string) => Promise<void> } }).R2_RENDERS;
    const put = r2.put.bind(r2);
    let once = true;
    r2.put = async (k, v) => {
      if (once && k === filmJobDocKey(filmId)) { once = false; throw new Error("put: internal (10001)"); }
      await put(k, v);
    };
  };

  it("a running finish step is asked to cancel", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    h.objects.set(filmJobDocKey(started.film_id), JSON.stringify(finishDoc(h.read(started.film_id))));
    failNextDocWrite(h, started.film_id);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).phase).toBe("failed");
    expect(h.cancels).toEqual(["fs-1"]);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.cancels, "asked once").toEqual(["fs-1"]);
  });

  it("a finish retry that fails cancels its step and keeps the film the user has", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const base = h.read(started.film_id);
    const prior = { ...base, phase: "done", film_key: "renders/film/film.mp4", keyframe_poll: undefined, keyframe_polls: undefined };
    h.objects.set(filmJobDocKey(started.film_id), JSON.stringify(finishDoc(base, { finish_retry_prior: JSON.stringify(prior) })));
    failNextDocWrite(h, started.film_id);
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    const doc = h.read(started.film_id);
    expect(h.cancels, "the retry's own step").toEqual(["fs-1"]);
    expect(doc.phase).toBe("done");
    expect(doc.film_key).toBe("renders/film/film.mp4");
  });

  it("a storage error that also blocks the read leaves the film for the next tick, and it recovers", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const r2 = (h.env as unknown as { R2_RENDERS: { get: (k: string) => Promise<unknown> } }).R2_RENDERS;
    const get = r2.get.bind(r2);
    const down = () => { r2.get = async () => { throw new Error("get: internal (10001)"); }; };
    down();
    await expect(advanceFilmJob(h.env, started.film_id, [kfMod])).rejects.toThrow("10001");
    expect(h.cancels).toEqual([]);
    r2.get = get;
    expect(h.read(started.film_id).phase).toBe("keyframe");
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.read(started.film_id).phase).toBe("keyframe");
  });

  for (const [name, text] of [["null", "null"], ["a number", "123"], ["a string", '"x"'], ["a list", "[]"], ["an empty object", "{}"]] as const) {
    it(`a doc that parses to ${name} fails the row, once, and does not wait for a later tick`, async () => {
      const h = harness({ keyframeParallel: "1", poll: () => pending });
      const started = await startFilmJob(h.env, START, [kfMod]);
      const bound: unknown[] = [];
      const stmt = { run: async () => ({ meta: { changes: 1 } }), first: async () => ({ one: 1 }), all: async () => ({ results: [] }) };
      (h.env as unknown as { DB: unknown }).DB = { prepare: () => ({ ...stmt, bind: (...a: unknown[]) => { bound.push(...a); return stmt; } }), batch: async () => [] };
      h.objects.set(filmJobDocKey(started.film_id), text);
      expect(await advanceFilmJob(h.env, started.film_id, [kfMod])).toBeNull();
      expect(bound.join(" ")).toContain("job doc corrupt");
    });
  }

  it("storage that stays down past a phase deadline fails the row, and stops", async () => {
    const h = harness({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const bound: unknown[] = [];
    const old = { updated_at: Date.now() / 1000 - PHASE_HARD_DEADLINE_SECONDS - 1 };
    const stmt = { run: async () => ({ meta: { changes: 1 } }), first: async () => ({ ...old, one: 1 }), all: async () => ({ results: [] }) };
    (h.env as unknown as { DB: unknown }).DB = { prepare: () => ({ ...stmt, bind: (...a: unknown[]) => { bound.push(...a); return stmt; } }), batch: async () => [] };
    const r2 = (h.env as unknown as { R2_RENDERS: { get: (k: string) => Promise<unknown> } }).R2_RENDERS;
    r2.get = async () => { throw new Error("get: internal (10001)"); };
    await expect(advanceFilmJob(h.env, started.film_id, [kfMod])).resolves.toBeNull();
    expect(bound.join(" ")).toContain("advance failed");
  });

  it("before that deadline it keeps waiting", async () => {
    const h = harness({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const stmt = { run: async () => ({ meta: { changes: 1 } }), first: async () => ({ updated_at: Date.now() / 1000 - 60, one: 1 }), all: async () => ({ results: [] }) };
    (h.env as unknown as { DB: unknown }).DB = { prepare: () => ({ ...stmt, bind: () => stmt }), batch: async () => [] };
    const r2 = (h.env as unknown as { R2_RENDERS: { get: (k: string) => Promise<unknown> } }).R2_RENDERS;
    r2.get = async () => { throw new Error("get: internal (10001)"); };
    await expect(advanceFilmJob(h.env, started.film_id, [kfMod])).rejects.toThrow("10001");
  });

  it("a write error after the film failed does not replace its reason", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => ({ ok: false, error: "keyframe: bad LoRA" }) });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const r2 = (h.env as unknown as { R2_RENDERS: { put: (k: string, v: string) => Promise<void> } }).R2_RENDERS;
    const put = r2.put.bind(r2);
    r2.put = async (k, v) => { if (k === filmJobDocKey(started.film_id) && v.includes("jobs_cancel_asked")) throw new Error("put: internal (10001)"); await put(k, v); };
    const bound: unknown[] = [];
    const stmt = { run: async () => ({ meta: { changes: 1 } }), first: async () => ({ one: 1 }), all: async () => ({ results: [] }) };
    (h.env as unknown as { DB: unknown }).DB = { prepare: () => ({ ...stmt, bind: (...a: unknown[]) => { bound.push(...a); return stmt; } }), batch: async () => [] };
    const r = await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(r?.job.error).toBe("keyframe: bad LoRA");
    expect(bound.join(" "), "the D1 row keeps the real reason too").not.toContain("advance failed");
  });

  it("a cancel that got a 503 is tried once more, and a token is dropped once told", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const env = h.env as unknown as { R2_RENDERS: { list: () => Promise<unknown> }; MODULE_KEYFRAME: { fetch: (u: string, i?: RequestInit) => Promise<Response> } };
    env.R2_RENDERS.list = async () => { throw new Error("list: internal (10001)"); };
    const real = env.MODULE_KEYFRAME.fetch;
    let cancels = 0;
    env.MODULE_KEYFRAME.fetch = async (u, i) => {
      if (String(u).endsWith("/cancel") && (cancels += 1) === 1) return new Response("", { status: 503 });
      return real(u, i);
    };
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(cancels).toBe(2);
    expect(h.read(started.film_id).keyframe_poll).toBeUndefined();
  });

  it("a cancel a module refuses keeps its token, and is not tried again", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const env = h.env as unknown as { R2_RENDERS: { list: () => Promise<unknown> }; MODULE_KEYFRAME: { fetch: (u: string, i?: RequestInit) => Promise<Response> } };
    env.R2_RENDERS.list = async () => { throw new Error("list: internal (10001)"); };
    const real = env.MODULE_KEYFRAME.fetch;
    let cancels = 0;
    env.MODULE_KEYFRAME.fetch = async (u, i) => {
      if (String(u).endsWith("/cancel")) { cancels += 1; return new Response(JSON.stringify({ ok: false, error: "no" }), { headers: { "content-type": "application/json" } }); }
      return real(u, i);
    };
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(cancels).toBe(1);
    expect(h.read(started.film_id).keyframe_poll).toBe("kf-poll-0");
  });

  it("a user cancel is not asked twice", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    await cancelFilmJob(h.env, started.film_id);
    const before = h.cancels.length;
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.cancels).toHaveLength(before);
    expect(h.read(started.film_id).jobs_cancel_asked).toBeUndefined();
  });

  it("a film failing with a running clip job stops that too", async () => {
    const h = harnessWithDb({ keyframeParallel: "1", poll: () => pending });
    const started = await startFilmJob(h.env, START, [kfMod]);
    const doc = h.read(started.film_id);
    const clipDoc = { job_id: "clips-1", binding: "MODULE_KEYFRAME", motion_backend: "keyframe", shots: [{ shot_id: "shot_01", prompt: "a", seconds: 4, status: "pending", poll: "clip-poll-1" }] };
    h.objects.set(clipJobDocKey("clips-1"), JSON.stringify(clipDoc));
    h.objects.set(filmJobDocKey(started.film_id), JSON.stringify({ ...doc, clip_job_id: "clips-1" }));
    const r2 = (h.env as unknown as { R2_RENDERS: { list: () => Promise<unknown> } }).R2_RENDERS;
    r2.list = async () => { throw new Error("list: internal (10001)"); };
    await advanceFilmJob(h.env, started.film_id, [kfMod]);
    expect(h.cancels).toContain("clip-poll-1");
  });
});

