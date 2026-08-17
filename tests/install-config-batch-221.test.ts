import { afterEach, describe, expect, it } from "vitest";
import { setInstallConfig } from "../src/operator-config.js";
import type { ConfigSchema } from "../src/modules/types.js";
import type { Env } from "../src/platform/orchestrator-context.js";
import type { Database } from "../src/platform/types.js";
import {
  tagOf,
  type CountingStmt,
  type Trip,
} from "./helpers/scatter-d1-trips.js";
import { openTestD1, type TestD1 } from "./helpers/d1-sqlite.js";

// core#221: setInstallConfig called `env.DB.batch!(writes)` on an OPTIONAL interface member
// with no surrounding catch. On a host whose Database omits batch it threw. The fix is the
// same guard as core#215: runPreparedWrites, sequential when batch is absent.
//
// THE INSTRUMENT is a live SQLite engine (so a silent no-op reddens on the stored values)
// with a trip recorder that can OMIT batch entirely. A fixture whose batch is a stub that
// works makes every claim below vacuous. A test that only asserts "it succeeds" against a
// host that HAS batch passes identically before and after.

const THREE: ConfigSchema = {
  notify_email: { type: "string", default: "", label: "recipient", scope: "install" },
  slack_hook: { type: "string", default: "", label: "slack", scope: "install" },
  retries_cap: { type: "int", default: 1, min: 0, max: 9, scope: "install" },
};

const MODULE = "notify-email-c221";
const PATCH = {
  notify_email: "ops@example.org",
  slack_hook: "https://hooks.example/c221",
  retries_cap: 4,
};

interface InstallHandle {
  env: Env;
  d1: TestD1;
  trips: Trip[];
  withTag(t: string): Trip[];
  bindsWithTag(t: string): unknown[][];
}

function liveInstallEnv(opts: { noBatch?: boolean } = {}): InstallHandle {
  const d1 = openTestD1();
  const trips: Trip[] = [];
  const inner = d1.DB as {
    prepare(sql: string): {
      bind(...args: unknown[]): {
        all(): Promise<unknown>;
        run(): Promise<unknown>;
        first(): Promise<unknown>;
      };
    };
  };

  function makeStmt(sql: string, binds: unknown[] = []): CountingStmt {
    // bind() returns a NEW statement. setInstallConfig prepares once and binds
    // per field; mutating one object would make every write carry the last bind.
    const stmt = {
      __sql: sql,
      __binds: binds,
      bind(...args: unknown[]) {
        return makeStmt(sql, args);
      },
      async first<T>() {
        trips.push({ kind: "single", tags: [tagOf(sql)], size: 1, binds: [stmt.__binds] });
        return (await inner.prepare(sql).bind(...stmt.__binds).first()) as T;
      },
      async run() {
        trips.push({ kind: "single", tags: [tagOf(sql)], size: 1, binds: [stmt.__binds] });
        return inner.prepare(sql).bind(...stmt.__binds).run();
      },
      async all<T>() {
        trips.push({ kind: "single", tags: [tagOf(sql)], size: 1, binds: [stmt.__binds] });
        return inner.prepare(sql).bind(...stmt.__binds).all() as Promise<{ results: T[] }>;
      },
    };
    return stmt as CountingStmt;
  }

  const db: Record<string, unknown> = { prepare: (sql: string) => makeStmt(sql) };
  if (!opts.noBatch) {
    db.batch = async (stmts: CountingStmt[]) => {
      trips.push({
        kind: "batch",
        tags: stmts.map((s) => tagOf(s.__sql)),
        size: stmts.length,
        binds: stmts.map((s) => s.__binds),
      });
      const out = [];
      for (const s of stmts) {
        out.push(await inner.prepare(s.__sql).bind(...s.__binds).run());
      }
      return out;
    };
  }

  return {
    env: { DB: db } as unknown as Env,
    d1,
    trips,
    withTag: (t) => trips.filter((x) => x.tags.includes(t)),
    bindsWithTag: (t) => trips.flatMap((trip) => trip.binds.filter((_, i) => trip.tags[i] === t)),
  };
}

function stored(d1: TestD1, moduleName: string): Record<string, unknown> {
  const rows = d1.raw
    .prepare(
      "SELECT field_key, value_json FROM operator_module_config WHERE module_name = ?",
    )
    .all(moduleName) as Array<{ field_key: string; value_json: string }>;
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.field_key] = JSON.parse(row.value_json);
  return out;
}

const open: InstallHandle[] = [];
function openEnv(opts: { noBatch?: boolean } = {}): InstallHandle {
  const h = liveInstallEnv(opts);
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length) open.pop()!.d1.close();
});

describe("core#221: setInstallConfig writes on a host with no DB.batch", () => {
  it("CONTROL (instrument): the no-batch fixture host genuinely OMITS batch, it is not a stub", () => {
    const withBatch = openEnv().env.DB as Database;
    const noBatch = openEnv({ noBatch: true }).env.DB as Database;
    expect(typeof withBatch.batch).toBe("function");
    expect(noBatch.batch).toBeUndefined();
    expect("batch" in (noBatch as object)).toBe(false);
  });

  it("CONTROL (instrument): tagOf names the install upsert, and rejects a near-miss", () => {
    // A matcher that also hit the SELECT would inflate the write count and hide a dropped write.
    expect(
      tagOf(
        "INSERT INTO operator_module_config (module_name, field_key, value_json, updated_at) VALUES (?, ?, ?, ?)",
      ),
    ).toBe("install-config-upsert");
    expect(
      tagOf("SELECT field_key, value_json FROM operator_module_config WHERE module_name = ?"),
    ).toBe("install-config-read");
    expect(tagOf("INSERT INTO renders (job_id, status) VALUES (?, ?)")).toBe("render-row-insert");
  });

  it("NO-BATCH host, N=3: all 3 of 3 fields are written, one statement per round trip", async () => {
    const h = openEnv({ noBatch: true });
    const next = await setInstallConfig(h.env, MODULE, THREE, PATCH);
    const upserts = h.withTag("install-config-upsert");
    const keys = h.bindsWithTag("install-config-upsert").map((b) => String(b[1]));
    const values = Object.fromEntries(
      h.bindsWithTag("install-config-upsert").map((b) => [String(b[1]), JSON.parse(String(b[2]))]),
    );
    console.log(
      `core#221 no-batch N=3: upserts=${upserts.length} keys=${JSON.stringify(keys)} stored=${JSON.stringify(stored(h.d1, MODULE))}`,
    );
    expect(upserts.length).toBe(3);
    expect(upserts.every((t) => t.kind === "single")).toBe(true);
    expect(keys.sort()).toEqual(["notify_email", "retries_cap", "slack_hook"]);
    expect(values).toEqual(PATCH);
    expect(stored(h.d1, MODULE)).toEqual(PATCH);
    expect(next).toEqual(PATCH);
  });

  it("NO-BATCH host: the write is the values, not merely a resolved promise", async () => {
    const h = openEnv({ noBatch: true });
    await setInstallConfig(h.env, MODULE, THREE, PATCH);
    // Independent of the function return: a silent no-op would still resolve with `next`
    // computed in memory. The table is the artifact.
    expect(stored(h.d1, MODULE)).toEqual(PATCH);
    expect(h.bindsWithTag("install-config-upsert").map((b) => b[0])).toEqual([
      MODULE,
      MODULE,
      MODULE,
    ]);
  });

  it("WITH batch, N=3: the batch path STILL batches -- one round trip carrying three statements", async () => {
    const h = openEnv();
    await setInstallConfig(h.env, MODULE, THREE, PATCH);
    const batched = h.withTag("install-config-upsert").filter((t) => t.kind === "batch");
    console.log(
      `core#221 with batch N=3: batched=${batched.length} size=${batched[0]?.size} stored=${JSON.stringify(stored(h.d1, MODULE))}`,
    );
    expect(batched.length).toBe(1);
    expect(batched[0].size).toBe(3);
    expect(h.withTag("install-config-upsert").filter((t) => t.kind === "single")).toEqual([]);
    expect(stored(h.d1, MODULE)).toEqual(PATCH);
  });

  it("N=1 is deliberately NOT the acceptance case: one statement is one round trip either way", async () => {
    const one: ConfigSchema = {
      notify_email: { type: "string", default: "", scope: "install" },
    };
    const h = openEnv({ noBatch: true });
    await setInstallConfig(h.env, MODULE, one, { notify_email: "solo@example.org" });
    expect(h.withTag("install-config-upsert").length).toBe(1);
    expect(stored(h.d1, MODULE)).toEqual({ notify_email: "solo@example.org" });
  });

  it("an all-render schema issues no write on either host", async () => {
    const renderOnly: ConfigSchema = {
      quality_tier: { type: "enum", values: ["a", "b"], default: "a" },
    };
    for (const opts of [{}, { noBatch: true }] as Array<{ noBatch?: boolean }>) {
      const h = openEnv(opts);
      const next = await setInstallConfig(h.env, MODULE, renderOnly, { quality_tier: "b" });
      expect(next).toEqual({});
      expect(h.withTag("install-config-upsert")).toEqual([]);
      expect(stored(h.d1, MODULE)).toEqual({});
    }
  });
});
