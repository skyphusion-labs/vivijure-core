import { afterEach, describe, expect, it, vi } from "vitest";
import { FilmNotStartedError, startFilmJob } from "../src/film-orchestrator.js";
import { MODULE_API, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-core#421. The number that matters is whether a door was invoked, against what the throw says.
afterEach(() => vi.restoreAllMocks());

const kf = {
  name: "kf", version: "1", api: MODULE_API, hooks: ["keyframe"], binding: "MODULE_KF", config_schema: {},
  ui: { order: 1, section: "keyframe" }, cancelable: true,
} as unknown as RegisteredModule;
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

function harness(failJobWrites: number) {
  const store = new Map<string, unknown>();
  const calls = { invoke: 0, cancel: 0, jobWrites: 0 };
  const env = {
    R2_RENDERS: {
      put: async (k: string, v: unknown) => {
        if (k.endsWith("film-job.json")) {
          calls.jobWrites += 1;
          if (calls.jobWrites <= failJobWrites) throw new Error("R2 500");
        }
        store.set(k, v);
      },
      get: async () => null,
      head: async () => null,
      delete: async () => {},
      list: async () => ({ objects: [], truncated: false }),
    },
    PRESIGNER: { presignGet: async (k: string) => `https://g/${k}`, presignPut: async (k: string) => `https://p/${k}` },
    MODULE_KF: {
      fetch: async (u: string) => {
        if (String(u).includes("cancel")) {
          calls.cancel += 1;
          return json({ ok: true });
        }
        calls.invoke += 1;
        return json({ ok: true, pending: true, poll: "tok" });
      },
    },
  } as unknown as Env;
  return { env, store, calls };
}
const args = (over: Record<string, unknown> = {}) => ({
  project: "p", bundle_key: "bundles/p.tar.gz", keyframe_backend: "kf",
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 3 }], idempotency_key: `k-${Math.random()}`, ...over,
});

describe("a throw before any invoke", () => {
  it("is FilmNotStartedError, and no door was called", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(0);
    const e = await startFilmJob(h.env, args({ scenes: [] }) as never, [kf]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FilmNotStartedError);
    expect((e as Error).message).toMatch(/no scenes/);
    expect(h.calls.invoke).toBe(0);
  });
});

describe("a job write that fails after the invoke", () => {
  it("is retried, so one failure loses nothing", async () => {
    const h = harness(2);
    const job = await startFilmJob(h.env, args() as never, [kf]);
    expect(h.calls.invoke).toBe(1);
    expect(h.calls.jobWrites).toBe(3);
    expect(h.store.has(`renders/${job.film_id}/film-job.json`)).toBe(true);
  });

  it("then cancels the job, and the throw is not read as nothing started", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(99);
    const e = await startFilmJob(h.env, args() as never, [kf]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(FilmNotStartedError);
    expect((e as Error).message).toMatch(/could not be written/);
    expect(h.calls.invoke).toBe(1);
    expect(h.calls.jobWrites).toBe(3);
    expect(h.calls.cancel, "a job nothing can find must not keep spending").toBe(1);
  });

  it("a failed cancel does not hide the write failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(99);
    (h.env as unknown as { MODULE_KF: { fetch: unknown } }).MODULE_KF.fetch = async (u: string) => {
      if (String(u).includes("cancel")) throw new Error("door down");
      return json({ ok: true, pending: true, poll: "tok" });
    };
    const e = await startFilmJob(h.env, args() as never, [kf]).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/could not be written/);
  });
});

describe("a throw from the invoke itself", () => {
  it("may have gone out, so it is not FilmNotStartedError", async () => {
    const h = harness(0);
    (h.env as unknown as { MODULE_KF: { fetch: unknown } }).MODULE_KF.fetch = async () => { throw new Error("socket closed"); };
    const e = await startFilmJob(h.env, args() as never, [kf]).then(() => null, (x: unknown) => x);
    expect(e === null || !(e instanceof FilmNotStartedError)).toBe(true);
  });
});

