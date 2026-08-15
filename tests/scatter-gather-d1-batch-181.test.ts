import { describe, it, expect } from "vitest";
import { advanceScatterJob } from "../src/scatter-orchestrator.js";
import { updateRenderFromView, markRenderFailedByJobId } from "../src/renders-db.js";
import { _resetModuleDiscoveryCache } from "../src/modules/registry.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { PreparedStatement } from "../src/platform/types.js";

// core#181: the scatter gather tick must not spend one D1 round trip PER SHARD on the render-row
// projection write. The submit path in the same file already issues its N shard rows as one
// `env.DB.batch()`; the gather path issued N sequential `updateRenderFromView` calls.
//
// THE INSTRUMENT: count D1 ROUND TRIPS across one `advanceScatterJob` call, tagged by statement.
// A correctness-only test passes identically before and after the change, so it cannot observe the
// fix -- the count is the only thing that can. Every reading below is driven with N > 1, because at
// N = 1 the batched and unbatched forms are indistinguishable (one round trip either way) and a
// suite that only drove N = 1 would go green against the unbatched code.
//
// A "round trip" is one call that crosses to D1: `.run()`, `.first()` or `.all()` on a prepared
// statement, or one `.batch()` however many statements it carries. That is the currency the issue
// is about, and the batch's whole point is that N statements cost one of them.

type Trip = { kind: "single" | "batch"; tags: string[]; size: number };

/** Classify a statement by its SQL, anchored at the start of the normalised text and matching
 *  enough of it to be unambiguous.
 *
 *  The first version of this matcher was `^UPDATE renders SET status = ` and it was WRONG: it also
 *  matched `markRenderFailedByJobId`, whose statement is `UPDATE renders SET status = 'FAILED'`, so
 *  a tick that failed its gather reported two more "render row updates" than it had issued. It was
 *  caught by printing the whole trip list beside the count rather than by reading the count. Hence
 *  both controls below: one proving the matcher MATCHES the statement under test, one proving it
 *  REJECTS that near-miss. */
function tagOf(sql: string): string {
  const s = sql.replace(/\s+/g, " ").trim();
  if (/^UPDATE renders SET status = \?, output_key = COALESCE\(\?, output_key\)/.test(s)) {
    return "render-row-update";
  }
  if (/^UPDATE renders SET status = 'FAILED'/.test(s)) return "mark-render-failed";
  if (/^UPDATE renders SET advance_lease = \?/.test(s)) return "lease-claim";
  if (/^UPDATE renders SET advance_lease = NULL/.test(s)) return "lease-release";
  if (/^SELECT id FROM renders/.test(s)) return "select-render-id";
  if (/^SELECT job_id, status FROM renders/.test(s)) return "select-scatter-children";
  if (/^SELECT 1 AS one FROM renders/.test(s)) return "select-film-row-exists";
  return `other: ${s.slice(0, 48)}`;
}

interface CountingStmt extends PreparedStatement {
  __sql: string;
}

/** A scatter job with `shards` live shards, plus a D1 round-trip recorder.
 *  `failBatch` makes every batched write reject, which is how the error-isolation case is driven.
 *  `noBatch` removes `DB.batch` entirely, which is a conformant host per platform/types.ts. */
function scatterEnv(shards: number, opts: { failBatch?: boolean; noBatch?: boolean } = {}) {
  const SID = `scatter-d1-181-${shards}${opts.failBatch ? "-failbatch" : ""}${opts.noBatch ? "-nobatch" : ""}`;
  const trips: Trip[] = [];
  // Fresh, so the film-job stall deadline (#129/#704) does not fire and the shards stay live. With
  // created_at 0 every shard fails on its own hard deadline and the tick measures the FAILURE path,
  // which is not the path this issue is about.
  const now = Date.now();

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
    created_at: now,
  };

  const docs = new Map<string, string>();
  docs.set(`renders/${SID}/scatter-job.json`, JSON.stringify(job));
  for (const id of shardIds) {
    docs.set(`renders/${id}/film-job.json`, JSON.stringify({
      film_id: id, project: "p", phase: "keyframe", created_at: now, scenes: [], finish_shots: [],
    }));
  }

  function makeStmt(sql: string): CountingStmt {
    const stmt: CountingStmt = {
      __sql: sql,
      bind() { return stmt; },
      async first<T>() {
        trips.push({ kind: "single", tags: [tagOf(sql)], size: 1 });
        if (/SELECT id FROM renders/i.test(sql)) return { id: 1 } as unknown as T;
        if (/SELECT 1 AS one FROM renders/i.test(sql)) return { one: 1 } as unknown as T;
        return null;
      },
      async run() {
        trips.push({ kind: "single", tags: [tagOf(sql)], size: 1 });
        return { success: true, meta: { changes: 1 } };
      },
      async all<T>() {
        trips.push({ kind: "single", tags: [tagOf(sql)], size: 1 });
        // Every shard row already exists, so ensureScatterRenderRow's #33 backfill inserts nothing.
        // Without this the fixture pays N extra INSERTs per tick and the measurement is about the
        // self-heal path rather than about the gather write.
        if (/SELECT job_id, status FROM renders/i.test(sql)) {
          return { results: shardIds.map((id) => ({ job_id: id, status: "IN_PROGRESS" })) as unknown as T[] };
        }
        return { results: [] as T[] };
      },
    };
    return stmt;
  }

  const db: Record<string, unknown> = { prepare: (sql: string) => makeStmt(sql) };
  if (!opts.noBatch) {
    db.batch = async (stmts: PreparedStatement[]) => {
      trips.push({
        kind: "batch",
        tags: stmts.map((s) => tagOf((s as CountingStmt).__sql)),
        size: stmts.length,
      });
      if (opts.failBatch) throw new Error("D1_ERROR: batch rejected (fixture)");
      return stmts.map(() => ({ success: true }));
    };
  }

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

  return {
    env: env as unknown as Env,
    scatterId: SID,
    trips,
    total: () => trips.length,
    withTag: (t: string) => trips.filter((x) => x.tags.includes(t)),
    savedPhase: async () => {
      const o = await (env as unknown as {
        R2_RENDERS: { get(k: string): Promise<{ text(): Promise<string> } | null> };
      }).R2_RENDERS.get(`renders/${SID}/scatter-job.json`);
      return JSON.parse(await o!.text()).phase as string;
    },
  };
}

async function measure(shards: number, opts: { failBatch?: boolean; noBatch?: boolean } = {}) {
  _resetModuleDiscoveryCache();
  const h = scatterEnv(shards, opts);
  const view = await advanceScatterJob(h.env, h.scatterId);
  return { ...h, view };
}

describe("core#181: a gather tick issues ONE batched render-row write, not one per shard", () => {
  it("CONTROL (positive): the recorder is non-empty BY CONSTRUCTION -- a planted write is counted and tagged", async () => {
    // A zero from this instrument would read exactly like a fixed gather tick. So plant a write
    // whose tag is known, in the same fixture the claims use, and read it BEFORE any claim.
    const h = scatterEnv(2);
    expect(h.total()).toBe(0);
    await updateRenderFromView(h.env, { jobId: "planted-1", status: "IN_PROGRESS", statusRaw: "IN_PROGRESS" });
    expect(h.withTag("render-row-update").length).toBe(1);
    expect(h.total()).toBe(1);
  });

  it("CONTROL (negative): the matcher REJECTS the near-miss statement it originally swallowed", async () => {
    // `markRenderFailedByJobId` is also an `UPDATE renders SET status = ...`. The first version of
    // tagOf() counted it as a render-row update and inflated every reading by two.
    const h = scatterEnv(2);
    await markRenderFailedByJobId(h.env, "planted-2", "boom");
    expect(h.total()).toBe(1);
    expect(h.withTag("render-row-update").length).toBe(0);
    expect(h.withTag("mark-render-failed").length).toBe(1);
  });

  it("CONTROL: a gather tick reaches the render-row write, and the shards stay live", async () => {
    const h = await measure(2);
    console.log(`core#181 trips N=2: ${JSON.stringify(h.trips.map((t) => `${t.kind}(${t.size}):${t.tags[0]}`))}`);
    // If this is 0 the tick never advanced a shard and every number below is worthless.
    expect(h.withTag("render-row-update").length).toBeGreaterThan(0);
    expect(h.withTag("lease-claim").length).toBe(2);
    expect(h.withTag("lease-release").length).toBe(2);
    // The measured path is the ordinary waiting gather, not the failure path.
    expect(h.withTag("mark-render-failed").length).toBe(0);
    expect(await h.savedPhase()).toBe("shards");
  });

  it("N=2: the render-row writes cost ONE round trip carrying TWO statements", async () => {
    const h = await measure(2);
    const rowTrips = h.withTag("render-row-update");
    console.log(`core#181 N=2 render-row-update round trips=${rowTrips.length} total D1 round trips=${h.total()}`);
    expect(rowTrips.length).toBe(1);
    expect(rowTrips[0].kind).toBe("batch");
    expect(rowTrips[0].size).toBe(2);
  });

  it("N=6: still ONE round trip, carrying SIX statements", async () => {
    const h = await measure(6);
    const rowTrips = h.withTag("render-row-update");
    console.log(`core#181 N=6 render-row-update round trips=${rowTrips.length} total D1 round trips=${h.total()}`);
    expect(rowTrips.length).toBe(1);
    expect(rowTrips[0].kind).toBe("batch");
    expect(rowTrips[0].size).toBe(6);
  });

  it("the render-row cost is INDEPENDENT of shard count, which is the property rather than a number", async () => {
    const readings: Array<[number, number]> = [];
    for (const s of [2, 3, 6, 12]) readings.push([s, (await measure(s)).withTag("render-row-update").length]);
    console.log(`core#181 sweep (shards, render-row round trips): ${JSON.stringify(readings)}`);
    expect([...new Set(readings.map(([, n]) => n))]).toEqual([1]);
  });

  it("TOTAL D1 round trips per tick grow by 2 per shard, not 3", async () => {
    // The two that remain are the film advance lease claim + release, which are NOT statements and
    // cannot be folded into a batch: each brackets a full orchestration tick with its own R2 reads
    // and module fan-out. The third -- the render-row write -- is the one this change removed from
    // the per-shard cost. Asserting the SLOPE rather than a single total keeps this honest if the
    // fixed per-tick overhead (the two SELECTs) ever changes.
    const a = await measure(2);
    const b = await measure(6);
    const slope = (b.total() - a.total()) / 4;
    console.log(`core#181 totals: N=2 -> ${a.total()}, N=6 -> ${b.total()}, slope=${slope} round trips per shard`);
    expect(slope).toBe(2);
  });

  it("N=1 is deliberately NOT the acceptance case: both forms cost one round trip", async () => {
    // Recorded so nobody later "simplifies" the suite to a single-shard case, which would go green
    // against the unbatched code.
    const h = await measure(1);
    expect(h.withTag("render-row-update").length).toBe(1);
  });

  it("a failing batch leaves every shard UNDETERMINED and does NOT fail the tick", async () => {
    // Error isolation is PRESERVED, not merely not-broken. The batch is all-or-nothing, so a batch
    // failure means NONE of the row writes landed -- which is the same condition the old per-shard
    // catch handled one shard at a time, true of every shard at once. Each contributing shard is
    // therefore downgraded to UNDETERMINED (IN_PROGRESS), the gather waits, and the tick still
    // returns a view instead of throwing.
    const h = await measure(4, { failBatch: true });
    expect(h.view).not.toBeNull();
    expect(h.view!.status).toBe("IN_PROGRESS");
    expect(h.withTag("render-row-update").length).toBe(1);
    // A failed projection write must never let the gather advance past the shards phase.
    expect(await h.savedPhase()).toBe("shards");
  });

  it("a host with no DB.batch still advances, one statement per round trip (platform/types.ts makes batch OPTIONAL)", async () => {
    // `Database.batch` is optional in the platform contract and vivijure-local may not provide it.
    // Calling `env.DB.batch!()` unconditionally would make every gather tick throw on such a host.
    const h = await measure(3, { noBatch: true });
    const rowTrips = h.withTag("render-row-update");
    console.log(`core#181 no-batch host N=3 render-row round trips=${rowTrips.length}`);
    expect(rowTrips.length).toBe(3);
    expect(rowTrips.every((t) => t.kind === "single")).toBe(true);
    expect(h.view).not.toBeNull();
    expect(await h.savedPhase()).toBe("shards");
  });
});
