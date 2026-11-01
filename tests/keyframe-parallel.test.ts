import { describe, expect, it } from "vitest";
import {
  advanceFilmJob,
  cancelInFlightKeyframe,
  partitionContiguous,
  resolveFilmFrame,
  resolveKeyframeParallel,
  startFilmJob,
  type FilmJob,
} from "../src/film-orchestrator.js";
import { filmJobDocKey, PHASE_HARD_DEADLINE_SECONDS } from "../src/film-model.js";
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

