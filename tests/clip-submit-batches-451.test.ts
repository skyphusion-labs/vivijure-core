import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceClipJob,
  startClipJob,
  clipsInFlight,
  queuedClipShots,
  expireStaleSubmitClaims,
  CLIP_SUBMIT_BATCH,
  CLIP_MAX_IN_FLIGHT,
  CLIP_SUBMIT_CLAIM_STALE_MS,
  CLIP_URL_TTL_SECONDS,
  type ClipJob,
  type ClipShotInput,
} from "../src/render-orchestrator.js";
import { MODULE_API, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import { craftFilmBytes } from "./helpers/mp4.js";

// vivijure-core#451 (vivijure-cf#1122 stage 1): a clip job is bought in claimed batches inside a window,
// and a shot's URLs are minted when it is submitted. Every test here counts PAID invokes, because that is
// the number a cut-off tick used to get wrong.

afterEach(() => vi.restoreAllMocks());
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

const motion: RegisteredModule = {
  name: "door", version: "1", api: MODULE_API, hooks: ["motion.backend"], binding: "MODULE_DOOR",
  config_schema: {}, ui: { order: 1, section: "motion", locality: "cloud" },
} as unknown as RegisteredModule;

/**
 * An async door (submit returns a poll token) over an in-memory R2. `tick` is the presign clock: every
 * URL carries the tick it was minted in, so a test can tell a fresh URL from one minted at t0.
 * `failPutAfter` makes the Nth doc write (1-based) throw, which is how a tick that dies mid-batch looks
 * to the next tick: the invokes happened and the record did not land.
 */
function harness(opts: { pollsToDone?: number } = {}) {
  const pollsToDone = opts.pollsToDone ?? 2;
  const store = new Map<string, Uint8Array>();
  const enc = (v: unknown) => (typeof v === "string" ? new TextEncoder().encode(v) : (v as Uint8Array));
  let docPuts = 0;
  let failPutAt = Infinity;
  const r2 = {
    put: async (k: string, v: unknown) => {
      if (k.endsWith("/clips-job.json")) {
        docPuts += 1;
        if (docPuts === failPutAt) throw new Error("tick ended");
      }
      store.set(k, enc(v));
    },
    get: async (k: string, o?: { range?: { offset: number; length: number } }) => {
      const whole = store.get(k);
      if (!whole) return null;
      const off = o?.range?.offset ?? 0;
      const v = whole.slice(off, off + (o?.range?.length ?? whole.length - off));
      return {
        text: async () => new TextDecoder().decode(v),
        arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
        body: v,
      };
    },
    head: async (k: string) => {
      const v = store.get(k);
      return v ? { size: v.length, etag: createHash("md5").update(v).digest("hex") } : null;
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, uploaded: new Date(Date.now()) })),
      truncated: false,
    }),
    delete: async (k: string) => { store.delete(k); },
  };
  const state = { tick: 0 };
  const presigns: { key: string; ttl: number; tick: number }[] = [];
  const invokes: { shot: string; keyframe_url?: string; tick: number }[] = [];
  const polls = new Map<string, number>();
  let maxInFlight = 0;
  const live = new Set<string>();
  const env = {
    R2_RENDERS: r2,
    PRESIGNER: {
      presignGet: async (k: string, ttl: number) => { presigns.push({ key: k, ttl, tick: state.tick }); return `https://g/${k}?t=${state.tick}`; },
      presignPut: async (k: string) => `https://p/${k}`,
    },
    MODULE_DOOR: {
      fetch: async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (url.endsWith("/invoke")) {
          const shot = body.input.shot_id as string;
          invokes.push({ shot, keyframe_url: body.input.keyframe_url, tick: state.tick });
          live.add(shot);
          maxInFlight = Math.max(maxInFlight, live.size);
          return json({ ok: true, pending: true, poll: `tok-${shot}` });
        }
        if (url.endsWith("/poll")) {
          const shot = String(body.poll).slice(4);
          const n = (polls.get(shot) ?? 0) + 1;
          polls.set(shot, n);
          if (n < pollsToDone) return json({ ok: true, pending: true });
          live.delete(shot);
          const clip_key = `renders/p/clips/${shot}_door.mp4`;
          store.set(clip_key, craftFilmBytes({ durationS: 5, frames: 120 }));
          return json({ ok: true, output: { shot_id: shot, clip_key, fps: 24, frames: 120 } });
        }
        return json({ ok: false, error: "unexpected route" });
      },
    },
  } as unknown as Env;
  const readDoc = (jobId: string): ClipJob =>
    JSON.parse(new TextDecoder().decode(store.get(`renders/${jobId}/clips-job.json`)!)) as ClipJob;
  return {
    env, state, presigns, invokes, polls, readDoc,
    maxInFlight: () => maxInFlight,
    failDocPutAt: (n: number) => { failPutAt = n; },
    docPuts: () => docPuts,
  };
}

const shots = (n: number, over: Partial<ClipShotInput> = {}): ClipShotInput[] =>
  Array.from({ length: n }, (_u, i) => {
    const id = `shot_${String(i + 1).padStart(3, "0")}`;
    return { shot_id: id, keyframe_url: "https://g/t0", keyframe_key: `renders/p/keyframes/${id}.png`, prompt: id, seconds: 5, ...over };
  });

const invokeCounts = (h: ReturnType<typeof harness>) => {
  const m = new Map<string, number>();
  for (const i of h.invokes) m.set(i.shot, (m.get(i.shot) ?? 0) + 1);
  return m;
};

/** The one clip job doc the harness holds. */
async function onlyJobId(h: ReturnType<typeof harness>): Promise<string> {
  const listed = await (h.env.R2_RENDERS as unknown as { list: (o: { prefix: string }) => Promise<{ objects: { key: string }[] }> })
    .list({ prefix: "renders/clips-" });
  expect(listed.objects.length).toBe(1);
  return listed.objects[0].key.split("/")[1];
}

async function driveToEnd(h: ReturnType<typeof harness>, jobId: string, maxTicks = 400): Promise<ClipJob> {
  let job = h.readDoc(jobId);
  for (let t = 0; t < maxTicks && job.shots.some((s) => s.status === "pending"); t++) {
    h.state.tick += 1;
    job = (await advanceClipJob(h.env, jobId, [motion]))!;
  }
  return job;
}

describe("vivijure-core#451: a clip job is bought in batches, inside a window", () => {
  it("start buys one batch, and 450 shots are each bought exactly once with the window never exceeded", async () => {
    quiet();
    const h = harness();
    const job = await startClipJob(h.env, { project: "p", shots: shots(450), motion_backend: "door" }, [motion]);
    expect(h.invokes.length).toBe(CLIP_SUBMIT_BATCH);
    // The doc on R2 already holds the tokens of everything bought.
    expect(h.readDoc(job.job_id).shots.filter((s) => s.poll).length).toBe(CLIP_SUBMIT_BATCH);
    const end = await driveToEnd(h, job.job_id);
    expect(end.shots.every((s) => s.status === "done")).toBe(true);
    const counts = invokeCounts(h);
    expect(counts.size).toBe(450);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(h.maxInFlight()).toBeLessThanOrEqual(CLIP_MAX_IN_FLIGHT);
  });

  it("a tick cut off after its invokes and before its record never buys those shots again", async () => {
    quiet();
    const h = harness();
    // Doc write 1 is the unbought start doc, 2 is the claim, 3 is the record. Kill the record.
    h.failDocPutAt(3);
    await expect(startClipJob(h.env, { project: "p", shots: shots(60), motion_backend: "door" }, [motion])).rejects.toThrow("tick ended");
    const firstBatch = h.invokes.map((i) => i.shot);
    expect(firstBatch.length).toBe(CLIP_SUBMIT_BATCH);
    const id = await onlyJobId(h);
    // The claim landed, the outcome did not.
    const claimed = h.readDoc(id).shots.filter((s) => s.submit_claim !== undefined);
    expect(claimed.map((s) => s.shot_id)).toEqual(firstBatch);
    const end = await driveToEnd(h, id, 50);
    const counts = invokeCounts(h);
    for (const s of firstBatch) expect(counts.get(s)).toBe(1);
    // The other 40 are bought once each; the claimed 20 hold the window until they go stale.
    expect(counts.size).toBe(20);
    expect(end.shots.filter((s) => s.submit_claim !== undefined).length).toBe(20);
  });

  it("a stale claim fails loudly as unknown and frees the window; it is never re-bought", async () => {
    quiet();
    const h = harness();
    h.failDocPutAt(3);
    await expect(startClipJob(h.env, { project: "p", shots: shots(30), motion_backend: "door" }, [motion])).rejects.toThrow();
    const id = await onlyJobId(h);
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + CLIP_SUBMIT_CLAIM_STALE_MS + 1);
    const end = await driveToEnd(h, id, 50);
    const unknown = end.shots.filter((s) => s.status === "failed" && /submit outcome unknown/.test(s.error ?? ""));
    expect(unknown.length).toBe(CLIP_SUBMIT_BATCH);
    const counts = invokeCounts(h);
    expect(counts.size).toBe(30);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(end.shots.filter((s) => s.status === "done").length).toBe(30 - CLIP_SUBMIT_BATCH);
  });
});

describe("vivijure-core#451: URLs are minted when the shot is submitted", () => {
  it("a film shot's keyframe URL comes from the tick it was submitted in, at the clip TTL", async () => {
    quiet();
    const h = harness();
    const job = await startClipJob(h.env, { project: "p", shots: shots(60, { presign_keys: true }), motion_backend: "door" }, [motion]);
    await driveToEnd(h, job.job_id);
    expect(h.invokes.length).toBe(60);
    for (const inv of h.invokes) {
      expect(inv.keyframe_url).toBe(`https://g/renders/p/keyframes/${inv.shot}.png?t=${inv.tick}`);
    }
    // Shots past the first batch went out on later ticks, which is the case a t0 URL could not cover.
    expect(new Set(h.invokes.map((i) => i.tick)).size).toBeGreaterThan(1);
    expect(h.presigns.every((p) => p.ttl === CLIP_URL_TTL_SECONDS)).toBe(true);
  });

  it("CONTROL: a caller's own URL is used as given when presign_keys is unset", async () => {
    quiet();
    const h = harness();
    await startClipJob(h.env, { project: "p", shots: shots(3), motion_backend: "door" }, [motion]);
    expect(h.invokes.map((i) => i.keyframe_url)).toEqual(["https://g/t0", "https://g/t0", "https://g/t0"]);
  });
});

describe("vivijure-core#451: the pure parts", () => {
  const base = (): ClipJob => ({
    job_id: "j", project: "p", motion_backend: "door", binding: "MODULE_DOOR", created_at: 0,
    shots: [
      { shot_id: "a", keyframe_url: "u", prompt: "x", seconds: 5, status: "pending" },
      { shot_id: "b", keyframe_url: "u", prompt: "x", seconds: 5, status: "pending", poll: "t" },
      { shot_id: "c", keyframe_url: "u", prompt: "x", seconds: 5, status: "pending", submit_claim: 1000 },
      { shot_id: "d", keyframe_url: "u", prompt: "x", seconds: 5, status: "done", clip_key: "k" },
    ],
  });
  it("counts a token and a claim as in flight, and only an unclaimed tokenless shot as queued", () => {
    expect(clipsInFlight(base())).toBe(2);
    expect(queuedClipShots(base()).map((s) => s.shot_id)).toEqual(["a"]);
  });
  it("expires a claim only once it is older than the stale window", () => {
    const j = base();
    expect(expireStaleSubmitClaims(j, 1000 + CLIP_SUBMIT_CLAIM_STALE_MS - 1)).toBe(0);
    expect(j.shots[2].status).toBe("pending");
    expect(expireStaleSubmitClaims(j, 1000 + CLIP_SUBMIT_CLAIM_STALE_MS)).toBe(1);
    expect(j.shots[2].status).toBe("failed");
    expect(j.shots[2].submit_claim).toBeUndefined();
  });
});
