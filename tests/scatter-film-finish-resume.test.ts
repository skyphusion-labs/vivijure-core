import { describe, it, expect } from "vitest";
import { advanceScatterJob } from "../src/scatter-orchestrator.js";
import { _resetModuleDiscoveryCache } from "../src/modules/registry.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// #23: on the scatter/gather path, a film with an ASYNC film.finish step (a title/credit card dispatched
// as a module job with a poll token) MUST NOT be marked COMPLETED before that step finishes. The bug:
// maybeFinalizeScatter called finalizeScatterDone UNCONDITIONALLY after runScatterFilmFinish, so an
// in-flight card was silently dropped and the render shipped a premature green (and the #600/#602/#663
// resume machinery was dead on this path). The fix parks the job in the non-terminal "finishing" phase
// while the step encodes, and only finalizes once the chain completes -- mirroring the single-film
// transitionToDone. This drives two poll ticks: tick 1 submits the card (stays "finishing", NOT done),
// tick 2 the card completes (finalizes to "done").

const SID = "scatter-ff-resume";
const FILM_KEY = `renders/${SID}/film.mp4`;

const FF_MANIFEST = {
  name: "film-titles", version: "0.1.0", api: "vivijure-module/2",
  hooks: ["film.finish"], provides: [], config_schema: {}, ui: { section: "film.finish", order: 10 },
};
function jr(b: unknown) { return new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } }); }

const scatterJob = () => ({
  scatter_id: SID,
  project: "p",
  bundle_key: `bundles/${SID}.tar.gz`,
  shard_film_ids: ["shard-a"],
  shard_shots: [["shot_01"]],
  expected_shot_ids: ["shot_01"],
  scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }],
  film_titles: { title: { text: "The End" } },
  // already assembled+muxed: the film exists, the shards are done, only the async card remains.
  phase: "finishing" as const,
  film_key: FILM_KEY,
  created_at: 0,
});

function resumeEnv() {
  let stored = JSON.stringify(scatterJob());
  let finishState: string | null = null;
  let markFinishDoneCalls = 0;
  const docKey = `renders/${SID}/scatter-job.json`;

  const db = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first() {
          if (/SELECT id FROM renders/i.test(sql)) return { id: 1 };          // row exists -> no self-heal insert
          if (/SELECT finish_state/i.test(sql)) return { finish_state: finishState, output_key: null };
          return null;
        },
        async run() {
          if (/status = 'COMPLETED'[\s\S]*finish_state = 'done'/i.test(sql)) { markFinishDoneCalls++; finishState = "done"; }
          return { success: true, meta: { changes: 1 } };
        },
        async all() { return { results: [] }; },
      };
    },
  };

  const env = {
    DB: db,
    R2_RENDERS: {
      get: async (k: string) => (k === docKey ? { text: async () => stored } : null),
      head: async () => null, // no deterministic card artifact yet -> the step submits/polls, never adopts
      put: async (k: string, b: string) => { if (k === docKey) stored = b; },
    },
    PRESIGNER: {
      presignGet: async (k: string) => `https://presigned/${k}`,
      presignPut: async (k: string) => `https://presigned-put/${k}`,
    },
    MODULE_FILM_TITLES: {
      fetch: async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/module.json")) return jr(FF_MANIFEST);
        if (url.endsWith("/invoke")) return jr({ ok: true, pending: true, poll: "card-tok" }); // async submit
        // /poll: the card finished encoding -> hand back the carded film.
        return jr({ ok: true, pending: false, output: { film_key: FILM_KEY.replace(/\.mp4$/, "-ff0.mp4"), applied: ["film-titles"] } });
      },
    },
  } as unknown as Env;

  return { env, read: () => JSON.parse(stored), markFinishDoneCalls: () => markFinishDoneCalls };
}

describe("scatter film.finish: an in-flight card never ships a premature green (#23)", () => {
  it("tick 1 submits the async card -> stays 'finishing', render NOT marked COMPLETED", async () => {
    _resetModuleDiscoveryCache();
    const { env, read, markFinishDoneCalls } = resumeEnv();
    const view = await advanceScatterJob(env, SID);
    expect(view?.status).toBe("IN_PROGRESS");         // NOT COMPLETED
    expect(read().phase).toBe("finishing");           // parked, non-terminal
    expect(read().film_finish).toBeUndefined();       // outcome not recorded yet
    expect(read().film_finish_polls?.[`renders/${SID}/film-ff0.mp4`]).toBe("card-tok"); // token persisted for resume
    expect(markFinishDoneCalls()).toBe(0);            // finalize was NOT called
  });

  it("tick 2: the card completes -> finalizes to 'done' and marks the render COMPLETED", async () => {
    _resetModuleDiscoveryCache();
    const { env, read, markFinishDoneCalls } = resumeEnv();
    await advanceScatterJob(env, SID);                 // tick 1: submit
    const view = await advanceScatterJob(env, SID);    // tick 2: poll -> complete
    expect(read().phase).toBe("done");
    expect(read().film_finish?.applied).toContain("film-titles");
    expect(view?.status).toBe("COMPLETED");
    expect(markFinishDoneCalls()).toBe(1);             // finalized exactly once, only after the card landed
  });
});
