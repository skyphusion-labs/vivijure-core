import { describe, it, expect, vi } from "vitest";
import { finalizeScatterSubmit } from "../src/scatter-orchestrator.js";
import type { ScatterJob } from "../src/scatter-orchestrator-types.js";
import type { Database } from "../src/platform/types.js";
import { scatterEnv, type ScatterEnvOpts, type ScatterEnvHandle } from "./helpers/scatter-d1-trips.js";

// core#215: the scatter SUBMIT path wrote its N shard rows as `env.DB.batch!(stmts)`, a non-null
// assertion on a member `platform/types.ts` declares OPTIONAL. The `!` satisfies the compiler and
// asserts nothing at runtime, so on a conformant host that does not implement `batch` the call
// throws a TypeError -- which the surrounding catch SWALLOWS as a d1.error. The submit therefore
// reports success while every shard row it was supposed to write silently never happened. That is
// the shape this suite has to be able to see: not a failure, an absence wearing the appearance of
// success.
//
// THE INSTRUMENT is the shared D1 round-trip recorder from core#181
// (tests/helpers/scatter-d1-trips.ts), extended to capture BINDS. A count alone cannot distinguish
// "three statements executed" from "one statement executed three times", and the claim under test
// is that every shard row actually reaches the host. So the assertions read the job_id bound into
// each INSERT, not just how many calls were made.
//
// The discriminating case is the NO-BATCH host. A test driven only against a host that HAS batch
// passes identically before and after this change and is structurally incapable of seeing the
// defect. Both are driven here: the no-batch host for the fix, the with-batch host to prove the
// batch path still costs ONE round trip rather than N.

/** job_id is bind index 1 of the INSERT built by buildInsertRenderStmt. */
const JOB_ID_BIND = 1;

function insertedJobIds(h: ScatterEnvHandle): string[] {
  return h.bindsWithTag("render-row-insert").map((b) => String(b[JOB_ID_BIND]));
}

function submitJob(scatterId: string, shards: number): { job: ScatterJob; shardRows: { jobId: string; status: string }[] } {
  const shardIds = Array.from({ length: shards }, (_, i) => `shard-${i}`);
  return {
    job: {
      scatter_id: scatterId,
      project: "p",
      bundle_key: `bundles/${scatterId}.tar.gz`,
      quality_tier: "draft",
      expected_shot_ids: shardIds.map((_, i) => `shot_${i}`),
      shard_film_ids: shardIds,
      shard_shots: shardIds.map((_, i) => [`shot_${i}`]),
      phase: "shards",
      created_at: Date.now(),
    },
    shardRows: shardIds.map((id) => ({ jobId: id, status: "IN_QUEUE" })),
  };
}

/** Run one submit against the recorder, capturing any structured d1.error the path swallows. */
async function submit(shards: number, opts: ScatterEnvOpts = {}) {
  const h = scatterEnv(shards, { ...opts, suffix: "submit215" });
  const { job, shardRows } = submitJob(h.scatterId, shards);
  const logged: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  });
  try {
    await finalizeScatterSubmit(h.env, job, shardRows);
  } finally {
    spy.mockRestore();
  }
  const d1Errors = logged.filter((l) => l.includes('"ev":"d1.error"') && l.includes("scatter.submit.rows"));
  return { ...h, d1Errors, shardIds: shardRows.map((r) => r.jobId) };
}

describe("core#215: scatter submit writes every shard row on a host with no DB.batch", () => {
  it("CONTROL (instrument): the no-batch fixture host genuinely OMITS batch, it is not a stub", async () => {
    // A fixture whose `batch` is a stub that quietly works would make every claim below vacuous:
    // the guarded and the unguarded code would behave identically against it. platform/types.ts
    // makes the member optional, so ABSENT is the conformant shape being modelled.
    const withBatch = scatterEnv(3, { suffix: "control-has" }).env.DB as Database;
    const noBatch = scatterEnv(3, { noBatch: true, suffix: "control-omits" }).env.DB as Database;
    expect(typeof withBatch.batch).toBe("function");
    expect(noBatch.batch).toBeUndefined();
    expect("batch" in (noBatch as object)).toBe(false);
  });

  it("CONTROL (positive): the recorder sees the submit's OWN writes, so a zero below means a zero", async () => {
    // If this instrument reported nothing, a dropped shard write would read exactly like a fixed
    // one. The parent row insert and the parent-id lookup are on the same path and are read first.
    const h = await submit(3);
    console.log(`core#215 trips (with batch, N=3): ${JSON.stringify(h.trips.map((t) => `${t.kind}(${t.size}):${t.tags[0]}`))}`);
    expect(h.total()).toBeGreaterThan(0);
    expect(h.withTag("select-render-id").length).toBe(1);
    expect(insertedJobIds(h)).toContain(h.scatterId); // the parent row
  });

  it("NO-BATCH host, N=3: all 3 of 3 shard rows are written, one statement per round trip", async () => {
    const h = await submit(3, { noBatch: true });
    const inserts = insertedJobIds(h);
    const shardInserts = inserts.filter((id) => id !== h.scatterId);
    console.log(`core#215 no-batch N=3: shard inserts ${shardInserts.length} of ${h.shardIds.length}, job_ids=${JSON.stringify(shardInserts)}`);
    // The DELTA, not the absence: every shard job_id actually crossed to D1, in order.
    expect(shardInserts).toEqual(h.shardIds);
    // No batch exists on this host, so each is its own round trip.
    expect(h.withTag("render-row-insert").every((t) => t.kind === "single")).toBe(true);
  });

  it("NO-BATCH host: the submit swallows NO d1.error -- the reason, not just the status", async () => {
    // This is the assertion that separates the fix from the defect. Before the fix the submit still
    // RESOLVED on a no-batch host: the TypeError from `env.DB.batch!` was caught and logged as a
    // structured d1.error, and the shard rows were left to the poll-path self-heal. A test that
    // asserted only "submit resolves" would have passed against that.
    const h = await submit(3, { noBatch: true });
    console.log(`core#215 no-batch N=3: swallowed d1.error lines = ${h.d1Errors.length} of 0 expected`);
    expect(h.d1Errors).toEqual([]);
  });

  it("NO-BATCH host: the shard-row cost is exactly N, across N = 2, 3, 6", async () => {
    const readings: Array<[number, number]> = [];
    for (const n of [2, 3, 6]) {
      const h = await submit(n, { noBatch: true });
      readings.push([n, insertedJobIds(h).filter((id) => id !== h.scatterId).length]);
    }
    console.log(`core#215 no-batch sweep (shards, shard-row inserts): ${JSON.stringify(readings)}`);
    expect(readings).toEqual([[2, 2], [3, 3], [6, 6]]);
  });

  it("WITH batch, N=3: the batch path STILL batches -- one round trip carrying three statements", async () => {
    // The fix must not quietly demote a batching host to sequential writes. That regression would
    // leave every assertion about correctness green while tripling the submit's D1 cost.
    const h = await submit(3, {});
    const batched = h.withTag("render-row-insert").filter((t) => t.kind === "batch");
    const shardInserts = insertedJobIds(h).filter((id) => id !== h.scatterId);
    console.log(`core#215 with batch N=3: batched round trips=${batched.length} size=${batched[0]?.size} shard job_ids=${JSON.stringify(shardInserts)}`);
    expect(batched.length).toBe(1);
    expect(batched[0].size).toBe(3);
    expect(shardInserts).toEqual(h.shardIds);
    // Exactly one single-statement insert on this host: the parent row.
    expect(h.withTag("render-row-insert").filter((t) => t.kind === "single").length).toBe(1);
  });

  it("N=1 is deliberately NOT the acceptance case: one statement is one round trip either way", async () => {
    // Recorded so nobody later 'simplifies' this suite to a single shard, where the batched and the
    // sequential forms are indistinguishable.
    const h = await submit(1, { noBatch: true });
    expect(insertedJobIds(h).filter((id) => id !== h.scatterId)).toEqual(["shard-0"]);
  });

  it("a submit with zero shard rows issues no shard write and no d1.error on either host", async () => {
    for (const opts of [{}, { noBatch: true }] as ScatterEnvOpts[]) {
      const h = scatterEnv(0, { ...opts, suffix: "empty215" });
      const { job } = submitJob(h.scatterId, 0);
      await finalizeScatterSubmit(h.env, job, []);
      expect(insertedJobIds(h)).toEqual([h.scatterId]); // parent only
    }
  });
});
