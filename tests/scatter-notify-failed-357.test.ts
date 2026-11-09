// core#357: a scatter render whose mux door is not configured fails, and now SAYS so.
//
// #348 widened the notify contract to `render.failed`. The film path announces a failed mux with the
// retained silent cut linked (degradeMuxUnavailable). fireNotifyForScatter opened with
// `if (!job.film_key) return;` and hardcoded `render.complete`, and the scatter mux leg for an
// unconfigured door leaves film_key unset. So a scatter render that paid for every shard ended with no
// notice at all. Now that leg sends `render.failed` and links the silent cut without making it film_key.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireNotifyForScatter } from "../src/scatter-notify.js";
import { advanceScatterJob, type ScatterJob } from "../src/scatter-orchestrator.js";
import * as registry from "../src/modules/registry.js";
import * as presign from "../src/presign.js";
import { HOOK_BLURBS, type RegisteredModule } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";

afterEach(() => vi.restoreAllMocks());

const notifier = {
  name: "notify-webhook",
  version: "0.1.0",
  api: "vivijure-module/2",
  binding: "MODULE_NOTIFY",
  hooks: ["notify"],
  config_schema: {},
} as unknown as RegisteredModule;

function setup(job: ScatterJob) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(registry, "discoverModules").mockResolvedValue([notifier]);
  vi.spyOn(presign, "presignR2Get").mockImplementation(async (_e, key) => `https://r2.example/${key}?signed`);
  const inputs: Record<string, unknown>[] = [];
  const docs: Record<string, string> = { [`renders/${job.scatter_id}/scatter-job.json`]: JSON.stringify(job) };
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ meta: { changes: 1 } }),
          first: async () => ({ job_id: job.scatter_id }),
          all: async () => ({ results: [] }),
        }),
      }),
      batch: async (s: unknown[]) => s.map(() => ({ meta: { changes: 1 } })),
    },
    R2_RENDERS: {
      get: async (k: string) => (k in docs ? { text: async () => docs[k] } : null),
      put: async (k: string, b: string) => { docs[k] = b; },
      head: async () => null,
      list: async () => ({ objects: [] }),
    },
    MODULE_NOTIFY: {
      fetch: async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
        if (body.input) inputs.push(body.input);
        return new Response(JSON.stringify({ ok: true, output: { delivered: ["webhook"] } }), { headers: { "content-type": "application/json" } });
      },
    },
  } as unknown as Env;
  const read = () => JSON.parse(docs[`renders/${job.scatter_id}/scatter-job.json`]) as ScatterJob;
  return { env, inputs, read };
}

function scatter(over: Partial<ScatterJob> = {}): ScatterJob {
  return {
    scatter_id: "scatter-357", project: "p", bundle_key: "b", quality_tier: "draft",
    expected_shot_ids: [], shard_film_ids: [], shard_shots: [], phase: "gather", created_at: Date.now(), ...over,
  } as ScatterJob;
}

describe("a FAILED scatter render notifies (core#357)", () => {
  it("an unconfigured mux door fails the render and sends render.failed with the silent cut", async () => {
    const job = scatter({ phase: "mux", silent_film_key: "renders/p/scatter-357-silent.mp4", audio_key: "audio/song.mp3" });
    const { env, inputs, read } = setup(job); // no VIDEO_FINISH_URL: the door is not configured
    const view = await advanceScatterJob(env, job.scatter_id);
    expect(view?.status).toBe("FAILED");
    const doc = read();
    expect(doc.error).toBe("video-finish URL not configured");
    expect(doc.film_key).toBeUndefined(); // retained, not delivered
    expect(inputs).toEqual([{
      event: "render.failed",
      film_id: "scatter-357",
      project: "p",
      download_url: "https://r2.example/renders/p/scatter-357-silent.mp4?signed",
    }]);
  });

  it("a completion still sends render.complete with the film", async () => {
    const { env, inputs } = setup(scatter());
    await fireNotifyForScatter(env, scatter({ phase: "done", film_key: "renders/p/film.mp4" }));
    expect(inputs).toEqual([{ event: "render.complete", film_id: "scatter-357", project: "p", download_url: "https://r2.example/renders/p/film.mp4?signed" }]);
  });

  it("a completion with no film announces nothing", async () => {
    const { env, inputs } = setup(scatter());
    await fireNotifyForScatter(env, scatter({ phase: "done" }));
    expect(inputs).toEqual([]);
  });

  it("a failure with nothing retained still announces, with no link", async () => {
    const { env, inputs } = setup(scatter());
    await fireNotifyForScatter(env, scatter({ phase: "failed" }), undefined, { event: "render.failed" });
    expect(inputs).toEqual([{ event: "render.failed", film_id: "scatter-357", project: "p" }]);
  });
});

describe("the notify hook table says what the contract types (core#357)", () => {
  it("the blurb names both events, not render-complete alone", () => {
    expect(HOOK_BLURBS.notify).toMatch(/complete/);
    expect(HOOK_BLURBS.notify).toMatch(/failed/);
  });
});
