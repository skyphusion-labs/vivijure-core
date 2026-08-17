// A D1 ROUND-TRIP RECORDER for the scatter paths, shared by the gather (core#181) and submit
// (core#215) acceptance suites.
//
// This started life inside `tests/scatter-gather-d1-batch-181.test.ts` and was lifted here
// unchanged (plus bind capture, below) when core#215 needed the SAME instrument on the submit
// path. Two fixtures claiming to model one host is how two suites end up disagreeing about what a
// conformant host is; there is one here.
//
// THE INSTRUMENT: count D1 ROUND TRIPS across one call, tagged by statement. A correctness-only
// test ("the call succeeded") passes identically before and after a batching change, so it cannot
// observe one -- the count is the only thing that can.
//
// A "round trip" is one call that crosses to D1: `.run()`, `.first()` or `.all()` on a prepared
// statement, or one `.batch()` however many statements it carries.
//
// BINDS are captured per statement (core#215) so a test can assert WHICH rows actually reached the
// host, not merely how many calls were made. A count alone cannot tell a dropped statement from a
// re-issued one.
import type { PreparedStatement } from "../../src/platform/types.js";
import type { Env } from "../../src/platform/orchestrator-context.js";

export type Trip = { kind: "single" | "batch"; tags: string[]; size: number; binds: unknown[][] };

/** Classify a statement by its SQL, anchored at the start of the normalised text and matching
 *  enough of it to be unambiguous.
 *
 *  The first version of this matcher was `^UPDATE renders SET status = ` and it was WRONG: it also
 *  matched `markRenderFailedByJobId`, whose statement is `UPDATE renders SET status = 'FAILED'`, so
 *  a tick that failed its gather reported two more "render row updates" than it had issued. It was
 *  caught by printing the whole trip list beside the count rather than by reading the count. Hence
 *  the controls in both suites: one proving the matcher MATCHES the statement under test, one
 *  proving it REJECTS that near-miss. */
export function tagOf(sql: string): string {
  const s = sql.replace(/\s+/g, " ").trim();
  if (/^UPDATE renders SET status = \?, output_key = COALESCE\(\?, output_key\)/.test(s)) {
    return "render-row-update";
  }
  if (/^UPDATE renders SET status = 'FAILED'/.test(s)) return "mark-render-failed";
  if (/^UPDATE renders SET advance_lease = \?/.test(s)) return "lease-claim";
  if (/^UPDATE renders SET advance_lease = NULL/.test(s)) return "lease-release";
  if (/^INSERT INTO renders \(/.test(s)) return "render-row-insert";
  if (/^SELECT id FROM renders/.test(s)) return "select-render-id";
  if (/^SELECT job_id, status FROM renders/.test(s)) return "select-scatter-children";
  if (/^SELECT 1 AS one FROM renders/.test(s)) return "select-film-row-exists";
  if (/^INSERT INTO operator_module_config \(/.test(s)) return "install-config-upsert";
  if (/^SELECT field_key, value_json FROM operator_module_config/.test(s)) {
    return "install-config-read";
  }
  return `other: ${s.slice(0, 48)}`;
}

export interface CountingStmt extends PreparedStatement {
  __sql: string;
  __binds: unknown[];
}

export interface ScatterEnvOpts {
  /** Every batched write rejects. Drives the error-isolation cases. */
  failBatch?: boolean;
  /** `DB.batch` is ABSENT, not stubbed. A conformant host per platform/types.ts, where the member
   *  is optional -- which is the whole reason core#181 and core#215 exist. */
  noBatch?: boolean;
  /** Distinguishes fixtures that would otherwise share a scatter id (R2 doc key). */
  suffix?: string;
}

export interface ScatterEnvHandle {
  env: Env;
  scatterId: string;
  trips: Trip[];
  total(): number;
  withTag(t: string): Trip[];
  /** Every bind row that reached the host under `tag`, flattened across singles and batches. */
  bindsWithTag(t: string): unknown[][];
  savedPhase(): Promise<string>;
}

/** A scatter job with `shards` live shards, plus a D1 round-trip recorder. */
export function scatterEnv(shards: number, opts: ScatterEnvOpts = {}): ScatterEnvHandle {
  const SID = `scatter-d1-${shards}${opts.failBatch ? "-failbatch" : ""}${opts.noBatch ? "-nobatch" : ""}${opts.suffix ? `-${opts.suffix}` : ""}`;
  const trips: Trip[] = [];
  // Fresh, so the film-job stall deadline (#129/#704) does not fire and the shards stay live. With
  // created_at 0 every shard fails on its own hard deadline and the tick measures the FAILURE path,
  // which is not the path these issues are about.
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
      __binds: [],
      bind(...args: unknown[]) { stmt.__binds = args; return stmt; },
      async first<T>() {
        trips.push({ kind: "single", tags: [tagOf(sql)], size: 1, binds: [stmt.__binds] });
        if (/SELECT id FROM renders/i.test(sql)) return { id: 1 } as unknown as T;
        if (/SELECT 1 AS one FROM renders/i.test(sql)) return { one: 1 } as unknown as T;
        return null;
      },
      async run() {
        trips.push({ kind: "single", tags: [tagOf(sql)], size: 1, binds: [stmt.__binds] });
        return { success: true, meta: { changes: 1 } };
      },
      async all<T>() {
        trips.push({ kind: "single", tags: [tagOf(sql)], size: 1, binds: [stmt.__binds] });
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
        binds: stmts.map((s) => (s as CountingStmt).__binds),
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
    bindsWithTag: (t: string) =>
      trips.flatMap((trip) => trip.binds.filter((_, i) => trip.tags[i] === t)),
    savedPhase: async () => {
      const o = await (env as unknown as {
        R2_RENDERS: { get(k: string): Promise<{ text(): Promise<string> } | null> };
      }).R2_RENDERS.get(`renders/${SID}/scatter-job.json`);
      return JSON.parse(await o!.text()).phase as string;
    },
  };
}
