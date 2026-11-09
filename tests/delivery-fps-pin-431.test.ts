// core#431: the frame is pinned on a film start (#430) and the rate was not. A long film's join refuses
// parts that differ, so a part with interpolation (48 fps) and a part without (24 fps) failed at the join
// even with one frame. startFilmJob now takes delivery_fps, as startFilmFromKeyframes already did, and
// both put the pin in the submit fingerprint.
import { afterEach, describe, expect, it, vi } from "vitest";
import { filmJobDocKey, startFilmJob } from "../src/film-orchestrator.js";
import { resolveDeliveryFps } from "../src/film-model.js";
import { filmSubmitClaimKey, naturalKeyForStartFilmJob, naturalKeyForStartFromKeyframes } from "../src/film-submit-idempotency.js";
import { MODULE_API, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

afterEach(() => vi.restoreAllMocks());

const kf = { name: "keyframe", version: "1.0.0", api: MODULE_API, binding: "MODULE_KEYFRAME", hooks: ["keyframe"], config_schema: {}, ui: { section: "keyframe", order: 1 } } as unknown as RegisteredModule;
const jsonResp = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

function harness() {
  const store = new Map<string, string>();
  const env = {
    R2_RENDERS: {
      put: async (k: string, v: string) => { store.set(k, v); },
      get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
      head: async () => null,
      delete: async (k: string) => { store.delete(k); },
      list: async () => ({ objects: [], truncated: false }),
    },
    [kf.binding]: { fetch: async (url: string) => (String(url).endsWith("/module.json") ? jsonResp(kf) : jsonResp({ ok: true, pending: true, poll: "t" })) },
  } as unknown as Env;
  const read = (id: string) => JSON.parse(store.get(filmJobDocKey(id)) as string) as Record<string, unknown>;
  return { env, read };
}

const START = { project: "p", bundle_key: "b", scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }], keyframes_only: true };

describe("a film start keeps the rate it was asked for", () => {
  it("is on the job, and it wins over the rate interpolation produced", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    const job = await startFilmJob(h.env, { ...START, delivery_width: 1920, delivery_height: 1080, delivery_fps: 24 }, [kf]);
    expect(job.delivery_fps).toBe(24);
    const doc = h.read(job.film_id);
    expect(doc.delivery_fps).toBe(24);
    // An interpolated part would otherwise ship at 48 and not join a part that shipped at 24.
    expect(resolveDeliveryFps({ ...doc, assemble_fps: 48 })).toBe(24);
  });

  it("CONTROL: with no rate asked for, none is invented, and the finish chain decides", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    const job = await startFilmJob(h.env, START, [kf]);
    expect("delivery_fps" in h.read(job.film_id)).toBe(false);
    expect(resolveDeliveryFps({ ...job, assemble_fps: 48 })).toBe(48);
  });
});

describe("the pin is in the submit fingerprint", () => {
  const key = async (a: Parameters<typeof naturalKeyForStartFilmJob>[0]) => filmSubmitClaimKey(naturalKeyForStartFilmJob(a));
  const kfKey = async (a: Parameters<typeof naturalKeyForStartFromKeyframes>[0]) => filmSubmitClaimKey(naturalKeyForStartFromKeyframes(a));
  const FK = { project: "p", bundle_key: "b", scenes: [], keyframes: [], derive_mode: "finalized" as const };

  for (const [field, patch] of [["delivery_fps", { delivery_fps: 48 }], ["delivery_width", { delivery_width: 1280 }], ["delivery_height", { delivery_height: 720 }]] as const) {
    it(`startFilmJob: changing ${field} changes the key`, async () => {
      const pinned = { ...START, delivery_width: 1920, delivery_height: 1080, delivery_fps: 24 };
      expect(await key({ ...pinned, ...patch })).not.toBe(await key(pinned));
    });
    it(`startFilmFromKeyframes: changing ${field} changes the key`, async () => {
      const pinned = { ...FK, delivery_width: 1920, delivery_height: 1080, delivery_fps: 24 };
      expect(await kfKey({ ...pinned, ...patch })).not.toBe(await kfKey(pinned));
    });
  }

  it("a pinned submit and an unpinned one are two films", async () => {
    expect(await key({ ...START, delivery_fps: 24 })).not.toBe(await key(START));
    expect(await kfKey({ ...FK, delivery_fps: 24 })).not.toBe(await kfKey(FK));
  });

  it("an unpinned submit adds nothing to the fingerprint, so its key is the one it had before core#431", async () => {
    // The pre-#431 natural object had no delivery fields. An unpinned submit must not gain one (not even a
    // null), or a submit in flight across the upgrade would stop deduplicating.
    for (const n of [naturalKeyForStartFilmJob(START).natural, naturalKeyForStartFromKeyframes(FK).natural]) {
      expect(Object.keys(n).filter((k) => k.startsWith("delivery_"))).toEqual([]);
    }
    expect(await key({ ...START, delivery_fps: undefined })).toBe(await key(START));
  });
});
