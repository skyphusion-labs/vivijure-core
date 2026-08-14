import { describe, it, expect } from "vitest";
import { advanceScatterJob } from "../src/scatter-orchestrator.js";
import { _resetModuleDiscoveryCache } from "../src/modules/registry.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// cf#515 Mode C: module discovery must not scale with SHARD COUNT.
//
// `advanceScatterJob` drives every shard inside ONE HTTP request, and each shard called
// `advanceFilmJob`, which discovers the module registry bare. #521 already established that
// manifests are static within a tick and threaded one registry through every phase leg of a film --
// but that bound is per-FILM, and scatter runs S film ticks per request, so it multiplied exactly
// the thing #521 bounded. A fan-out is one subrequest per bound module, so the cost was S x M.
//
// THE INSTRUMENT, used unchanged before and after the fix: count `/module.json` fetches issued
// across one `advanceScatterJob` call. That is the real currency -- on Workers every module-binding
// fetch is a subrequest -- and it is deterministic, so the before and after numbers are comparable.
//
// The assertion is deliberately "independent of S" rather than a fixed number: pinning "27" would
// pass for a fix that happened to discover once per REQUEST today and silently regress the moment a
// second discovering caller appeared.

function jr(b: unknown) {
  return new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
}

const MANIFEST = (n: number) => ({
  name: `mod-${n}`,
  version: "0.1.0",
  api: "vivijure-module/2",
  hooks: [],
  provides: [],
  config_schema: {},
  ui: { section: "finish", order: n },
});

/** A scatter job with `shards` shards and `modules` bound modules. Returns the env plus the live
 *  manifest-fetch counter, which is the whole measurement. */
function scatterEnv(shards: number, modules: number) {
  const SID = `scatter-fanout-${shards}x${modules}`;
  let manifestFetches = 0;

  const shardIds = Array.from({ length: shards }, (_, i) => `shard-${i}`);
  const job = {
    scatter_id: SID,
    project: "p",
    bundle_key: `bundles/${SID}.tar.gz`,
    shard_film_ids: shardIds,
    shard_shots: shardIds.map((_, i) => [`shot_${i}`]),
    expected_shot_ids: shardIds.map((_, i) => `shot_${i}`),
    scenes: shardIds.map((_, i) => ({ shot_id: `shot_${i}`, prompt: "x", seconds: 4 })),
    phase: "shards" as const,
    created_at: 0,
  };

  const docs = new Map<string, string>();
  docs.set(`renders/${SID}/scatter-job.json`, JSON.stringify(job));
  for (const id of shardIds) {
    // A film doc that reaches the discovery line and then has no phase work to do. Discovery in
    // advanceFilmJobLocked runs BEFORE every phase leg, so any non-cancelled doc costs a fan-out.
    docs.set(`renders/${id}/film-job.json`, JSON.stringify({
      film_id: id, project: "p", phase: "keyframe", created_at: 0, scenes: [], finish_shots: [],
    }));
  }

  const db = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first() {
          if (/SELECT id FROM renders/i.test(sql)) return { id: 1 };
          return null;
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
        async all() { return { results: [] }; },
      };
    },
  };

  const env: Record<string, unknown> = {
    DB: db,
    R2_RENDERS: {
      get: async (k: string) => (docs.has(k) ? { text: async () => docs.get(k)! } : null),
      head: async () => null,
      put: async (k: string, b: string) => { docs.set(k, String(b)); },
      list: async () => ({ objects: [], truncated: false }),
      delete: async () => {},
    },
    PRESIGNER: {
      presignGet: async (k: string) => `https://presigned/${k}`,
      presignPut: async (k: string) => `https://presigned-put/${k}`,
    },
  };

  for (let n = 0; n < modules; n += 1) {
    env[`MODULE_M${String(n).padStart(2, "0")}`] = {
      fetch: async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/module.json")) { manifestFetches += 1; return jr(MANIFEST(n)); }
        return jr({ ok: true, pending: false, output: {} });
      },
    };
  }

  return { env: env as unknown as Env, scatterId: SID, fetches: () => manifestFetches };
}

async function measure(shards: number, modules: number) {
  _resetModuleDiscoveryCache();
  const { env, scatterId, fetches } = scatterEnv(shards, modules);
  await advanceScatterJob(env, scatterId);
  return fetches();
}

describe("cf#515 Mode C: scatter discovery must not scale with shard count", () => {
  const M = 27; // the live catalogue size, so the numbers here are the ones on the issue

  it("CONTROL: the instrument counts, and one shard costs exactly one fan-out", async () => {
    const n = await measure(1, M);
    // If this is 0 the harness is not reaching discovery at all and every number below is worthless.
    expect(n).toBeGreaterThan(0);
    expect(n).toBe(M);
  });

  it("CONTROL: the instrument is sensitive to M, so it is measuring the fan-out and not a constant", async () => {
    expect(await measure(1, 5)).toBe(5);
    expect(await measure(1, 11)).toBe(11);
  });

  it("2 shards cost ONE fan-out, not two", async () => {
    const n = await measure(2, M);
    console.log(`cf#515 Mode C: shards=2 modules=${M} manifest fetches=${n}`);
    expect(n).toBe(M);
  });

  it("6 shards cost ONE fan-out, not six", async () => {
    const n = await measure(6, M);
    console.log(`cf#515 Mode C: shards=6 modules=${M} manifest fetches=${n}`);
    expect(n).toBe(M);
  });

  it("an early-return tick pays NOTHING: discovery sits below the cancelled/done/failed exits", async () => {
    // The fix moves discovery to just above the shard loop rather than the top of the function. That
    // placement is a claim in a comment, and a claim in a comment is exactly what nothing checks --
    // so it gets an assertion. Hoisting discovery to the top would add a fan-out to every poll of an
    // already-finished render, which is a NEW cost introduced by a change whose purpose is removing
    // one, and no test above would notice.
    for (const phase of ["done", "failed"] as const) {
      _resetModuleDiscoveryCache();
      const { env, scatterId, fetches } = scatterEnv(6, M);
      const key = `renders/${scatterId}/scatter-job.json`;
      const doc = JSON.parse(await (await (env as unknown as { R2_RENDERS: { get(k: string): Promise<{ text(): Promise<string> }> } }).R2_RENDERS.get(key)).text());
      doc.phase = phase;
      await (env as unknown as { R2_RENDERS: { put(k: string, b: string): Promise<void> } }).R2_RENDERS.put(key, JSON.stringify(doc));
      await advanceScatterJob(env, scatterId);
      console.log(`cf#515 Mode C: early-return phase=${phase} manifest fetches=${fetches()}`);
      expect(fetches()).toBe(0);
    }
  });

  it("the cost is INDEPENDENT of shard count, which is the property rather than any single number", async () => {
    const readings: Array<[number, number]> = [];
    for (const s of [1, 2, 3, 6, 12]) readings.push([s, await measure(s, M)]);
    console.log(`cf#515 Mode C sweep (shards, fetches): ${JSON.stringify(readings)}`);
    const distinct = new Set(readings.map(([, n]) => n));
    expect([...distinct]).toEqual([M]);
  });
});
