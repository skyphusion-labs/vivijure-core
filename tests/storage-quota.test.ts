import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  STORAGE_REBUILD_DDL,
  STORAGE_USAGE_DDL,
  StorageReconcileTooLargeError,
  checkStorageQuota,
  isMeteredStore,
  isStorageSubmitRoute,
  meteredObjectStore,
  meteredR2Bucket,
  putValueByteLength,
  recordObjectDelete,
  recordObjectWrite,
  reconcileStorageUsage,
  markStorageLedgerTrue,
  storageLedgerTrueSince,
  storageQuotaBytes,
  storageQuotaMode,
  storageQuotaState,
  storageSubmitPatterns,
  storageUsage,
  storageUsedBytes,
} from "../src/storage-quota.js";
import type { Database, PreparedStatement } from "../src/platform/types.js";
import type { R2Bucket } from "../src/platform/r2-types.js";

// ---------------------------------------------------------------- a real-enough DB fake
//
// An in-memory ledger behind the D1 statement shape. It implements the three statements the module
// issues (upsert / delete-one / delete-all / sum) rather than pattern-matching loosely, so a change to
// the SQL that the fake does not understand FAILS here instead of silently no-oping.

interface FakeDb extends Database {
  rows: Map<string, number>;
  calls: string[];
  /** storage_usage_meta, and whether it EXISTS yet: core creates it where it writes it. */
  meta: Map<string, string>;
  metaTableExists: boolean;
  /** storage_usage_rebuild: the cf#516 staging table, created where it is written like meta. */
  rebuild: Map<string, number>;
  rebuildTableExists: boolean;
  failNext?: string;
}

function fakeDb(): FakeDb {
  const rows = new Map<string, number>();
  const calls: string[] = [];
  const db = {
    rows,
    calls,
    meta: new Map<string, string>(),
    metaTableExists: false,
    rebuild: new Map<string, number>(),
    rebuildTableExists: false,
  } as FakeDb;

  // D1 semantics: prepare() yields a statement, and bind() yields a NEW statement carrying ITS OWN
  // values, so one prepared statement can be bound many times (the pattern reconcile uses).
  const make = (norm: string, bound: unknown[]): PreparedStatement => ({
    bind(...values: unknown[]) {
      return make(norm, values);
    },
    async first<T>() {
      calls.push(norm);
      if (db.failNext && norm.includes(db.failNext)) throw new Error("db exploded");
      if (norm.startsWith("SELECT value FROM storage_usage_meta")) {
        // A real database throws on a table that does not exist; so does this, because the
        // "never established" path in core depends on that being the observed behaviour.
        if (!db.metaTableExists) throw new Error("no such table: storage_usage_meta");
        const value = db.meta.get(String(bound[0]));
        return (value === undefined ? null : { value }) as T;
      }
      if (norm.startsWith("SELECT COALESCE(SUM(bytes)")) {
        let total = 0;
        for (const v of rows.values()) total += v;
        return { total, objects: rows.size } as T;
      }
      throw new Error(`fake db does not understand: ${norm}`);
    },
    async run() {
      calls.push(norm);
      if (db.failNext && norm.includes(db.failNext)) throw new Error("db exploded");
      if (norm.startsWith("CREATE TABLE IF NOT EXISTS storage_usage_meta")) {
        db.metaTableExists = true;
      } else if (norm.startsWith("CREATE TABLE IF NOT EXISTS storage_usage_rebuild")) {
        db.rebuildTableExists = true;
      } else if (norm.startsWith("INSERT INTO storage_usage_meta")) {
        db.meta.set(String(bound[0]), String(bound[1]));
      } else if (norm.startsWith("DELETE FROM storage_usage_meta WHERE key = ?")) {
        db.meta.delete(String(bound[0]));
      } else if (norm.startsWith("INSERT INTO storage_usage_rebuild")) {
        if (!db.rebuildTableExists) throw new Error("no such table: storage_usage_rebuild");
        db.rebuild.set(String(bound[0]), Number(bound[1]));
      } else if (norm.startsWith("DELETE FROM storage_usage_rebuild")) {
        db.rebuild.clear();
      } else if (norm.startsWith("INSERT INTO storage_usage (object_key, bytes, updated_at) SELECT")) {
        // The swap's promote step: staged rows become the ledger.
        if (!db.rebuildTableExists) throw new Error("no such table: storage_usage_rebuild");
        for (const [k, v] of db.rebuild) rows.set(k, v);
      } else if (norm.startsWith("INSERT INTO storage_usage")) {
        rows.set(String(bound[0]), Number(bound[1]));
      } else if (norm.startsWith("DELETE FROM storage_usage WHERE object_key = ?")) {
        rows.delete(String(bound[0]));
      } else if (norm.startsWith("DELETE FROM storage_usage WHERE object_key LIKE")) {
        const prefix = String(bound[0]);
        for (const k of [...rows.keys()]) if (k.startsWith(prefix)) rows.delete(k);
      } else if (norm.startsWith("DELETE FROM storage_usage")) {
        rows.clear();
      } else {
        throw new Error(`fake db does not understand: ${norm}`);
      }
      return { success: true };
    },
    async all<T>() {
      return { results: [] as T[] };
    },
  });

  db.prepare = (sql: string) => make(sql.replace(/\s+/g, " ").trim(), []);
  return db;
}

// CONTROL: prove the fake behaves like D1 (a bound statement carries ITS OWN values, so preparing
// once and binding twice does not cross-contaminate). Every assertion below rides on this.
describe("the DB fake itself (control)", () => {
  it("binds per statement, like D1", async () => {
    const db = fakeDb();
    const stmt = db.prepare(
      "INSERT INTO storage_usage (object_key, bytes, updated_at) VALUES (?, ?, ?) ON CONFLICT(object_key) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at",
    );
    const a = stmt.bind("a", 10, 1);
    const b = stmt.bind("b", 20, 1);
    await a.run();
    await b.run();
    expect([...db.rows.entries()].sort()).toEqual([
      ["a", 10],
      ["b", 20],
    ]);
  });
});

describe("storageQuotaBytes (the knob)", () => {
  it("is OFF when unset, empty, zero, negative, or garbage", () => {
    expect(storageQuotaBytes({})).toBeNull();
    expect(storageQuotaBytes({ R2_STORAGE_QUOTA_BYTES: "" })).toBeNull();
    expect(storageQuotaBytes({ R2_STORAGE_QUOTA_BYTES: "   " })).toBeNull();
    expect(storageQuotaBytes({ R2_STORAGE_QUOTA_BYTES: "0" })).toBeNull();
    expect(storageQuotaBytes({ R2_STORAGE_QUOTA_BYTES: "-5" })).toBeNull();
    expect(storageQuotaBytes({ R2_STORAGE_QUOTA_BYTES: "10GB" })).toBeNull();
    expect(storageQuotaBytes({ R2_STORAGE_QUOTA_BYTES: "1.5" })).toBeNull();
    // A number (not a string) is not the wire shape a host var arrives in; treated as unset.
    expect(storageQuotaBytes({ R2_STORAGE_QUOTA_BYTES: 100 })).toBeNull();
  });

  it("reads a positive integer byte count", () => {
    expect(storageQuotaBytes({ R2_STORAGE_QUOTA_BYTES: "1" })).toBe(1);
    expect(storageQuotaBytes({ R2_STORAGE_QUOTA_BYTES: " 53687091200 " })).toBe(53687091200);
  });
});

describe("the ledger", () => {
  it("upserts per key: re-writing the SAME key never double counts", async () => {
    const db = fakeDb();
    await recordObjectWrite(db, "renders/a.mp4", 100);
    await recordObjectWrite(db, "renders/a.mp4", 250);
    expect(await storageUsedBytes(db)).toBe(250);
    expect((await storageUsage(db)).objects).toBe(1);
  });

  it("sums across keys and decrements on delete", async () => {
    const db = fakeDb();
    await recordObjectWrite(db, "a", 10);
    await recordObjectWrite(db, "b", 15);
    expect(await storageUsedBytes(db)).toBe(25);
    await recordObjectDelete(db, "a");
    expect(await storageUsedBytes(db)).toBe(15);
    // Deleting an unaccounted key is a no-op, not an error (a studio whose accounting started mid-life).
    await recordObjectDelete(db, "never-seen");
    expect(await storageUsedBytes(db)).toBe(15);
  });

  it("refuses to record a nonsense size rather than poisoning the total", async () => {
    const db = fakeDb();
    await expect(recordObjectWrite(db, "a", -1)).rejects.toThrow(/refusing to record/);
    await expect(recordObjectWrite(db, "a", Number.NaN)).rejects.toThrow(/refusing to record/);
    expect(await storageUsedBytes(db)).toBe(0);
  });

  it("reports 0 on an empty ledger", async () => {
    expect(await storageUsedBytes(fakeDb())).toBe(0);
  });
});

describe("checkStorageQuota (enforcement)", () => {
  it("knob OFF: allows, and never touches the database", async () => {
    const db = fakeDb();
    const verdict = await checkStorageQuota({ DB: db });
    expect(verdict.ok).toBe(true);
    expect(db.calls).toEqual([]);
  });

  it("under the ceiling: allows, carrying the real numbers", async () => {
    const db = fakeDb();
    await recordObjectWrite(db, "a", 400);
    const verdict = await checkStorageQuota({ DB: db, R2_STORAGE_QUOTA_BYTES: "1000" });
    expect(verdict).toMatchObject({ ok: true, usedBytes: 400, quotaBytes: 1000 });
  });

  it("AT the ceiling: DENIES 507 (a full studio is full)", async () => {
    const db = fakeDb();
    await recordObjectWrite(db, "a", 1000);
    const verdict = await checkStorageQuota({ DB: db, R2_STORAGE_QUOTA_BYTES: "1000" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.status).toBe(507);
    // HONEST deny: both real numbers are in the message the operator sees.
    expect(verdict.message).toContain("1000 bytes stored");
    expect(verdict.message).toContain("1000-byte R2_STORAGE_QUOTA_BYTES");
    expect(verdict.usedBytes).toBe(1000);
  });

  it("over the ceiling: DENIES 507 with the real used total", async () => {
    const db = fakeDb();
    await recordObjectWrite(db, "a", 2048);
    const verdict = await checkStorageQuota({ DB: db, R2_STORAGE_QUOTA_BYTES: "1024" });
    if (verdict.ok) throw new Error("expected a deny");
    expect(verdict.status).toBe(507);
    expect(verdict.message).toContain("2048 bytes stored");
  });

  it("quota set but NO database: fails CLOSED (503), never silently unmetered", async () => {
    const verdict = await checkStorageQuota({ R2_STORAGE_QUOTA_BYTES: "1024" });
    if (verdict.ok) throw new Error("expected a deny");
    expect(verdict.status).toBe(503);
    expect(verdict.message).toContain("database is unavailable");
  });

  it("quota set but the ledger read THROWS: fails CLOSED (503)", async () => {
    const db = fakeDb();
    db.failNext = "SELECT COALESCE(SUM(bytes)";
    const verdict = await checkStorageQuota({ DB: db, R2_STORAGE_QUOTA_BYTES: "1024" });
    if (verdict.ok) throw new Error("expected a deny");
    expect(verdict.status).toBe(503);
    expect(verdict.message).toContain("db exploded");
  });
});

// ---------------------------------------------------------------- cp#195: the mode knob

describe("storageQuotaMode (the mode knob)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("defaults to deny for unset, empty and whitespace", () => {
    expect(storageQuotaMode({})).toBe("deny");
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: "" })).toBe("deny");
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: "   " })).toBe("deny");
    // A non-string (a host that bound a number, or a stray object) is not a mode.
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: 1 })).toBe("deny");
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: null })).toBe("deny");
    // None of those is a misconfiguration, so none of them warns.
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts both modes, trimmed and case-insensitively, without warning", () => {
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: "meter" })).toBe("meter");
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: "  METER  " })).toBe("meter");
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: "deny" })).toBe("deny");
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: "Deny" })).toBe("deny");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to deny on an unrecognised value, LOUDLY", () => {
    // The safe side: guessing meter on a typo turns a hard stop into unmetered spend. Guessing deny
    // costs a refused submit that names the knob.
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: "metre" })).toBe("deny");
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: "off" })).toBe("deny");
    expect(storageQuotaMode({ R2_STORAGE_QUOTA_MODE: "true" })).toBe("deny");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0][0])).toContain("R2_STORAGE_QUOTA_MODE");
  });
});

// CONTROL (cp#195): `deny` must be BYTE-IDENTICAL to what core#52 shipped, and it must stay the
// default under every way of not asking for `meter`.
//
// This is a CONTROL rather than a coverage test, and the difference is the loop. Asserting the deny
// path once with the mode unset would pass just as happily if a later change made `meter` the
// default for, say, an empty string, or made an unrecognised value mean meter. So every input that
// must resolve to deny is driven through the SAME expectations, and the expectations pin the exact
// message text rather than a substring of it: the message IS the operator-visible behaviour, and
// "byte-identical" is a claim about that string, not about a status code alone.
describe("cp#195 CONTROL: deny is byte-identical to core#52, and is the default", () => {
  const DENY_INPUTS: Array<[string, Record<string, unknown>]> = [
    ["mode unset", {}],
    ["mode empty", { R2_STORAGE_QUOTA_MODE: "" }],
    ["mode whitespace", { R2_STORAGE_QUOTA_MODE: "  " }],
    ["mode explicitly deny", { R2_STORAGE_QUOTA_MODE: "deny" }],
    ["mode unrecognised", { R2_STORAGE_QUOTA_MODE: "metre" }],
    ["mode not a string", { R2_STORAGE_QUOTA_MODE: 7 }],
  ];

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [label, modeEnv] of DENY_INPUTS) {
    it(`${label}: AT the ceiling denies 507 with the core#52 message, verbatim`, async () => {
      const db = fakeDb();
      await recordObjectWrite(db, "a", 1000);
      const verdict = await checkStorageQuota({ DB: db, R2_STORAGE_QUOTA_BYTES: "1000", ...modeEnv });
      if (verdict.ok) throw new Error("expected a deny");
      expect(verdict.mode).toBe("deny");
      expect(verdict.status).toBe(507);
      expect(verdict.message).toBe(
        "storage quota reached: 1000 bytes stored of the 1000-byte R2_STORAGE_QUOTA_BYTES ceiling; delete renders or raise the knob",
      );
      expect(verdict.usedBytes).toBe(1000);
      expect(verdict.quotaBytes).toBe(1000);
    });

    it(`${label}: no database fails CLOSED 503 with the core#52 message, verbatim`, async () => {
      const verdict = await checkStorageQuota({ R2_STORAGE_QUOTA_BYTES: "1024", ...modeEnv });
      if (verdict.ok) throw new Error("expected a deny");
      expect(verdict.mode).toBe("deny");
      expect(verdict.status).toBe(503);
      expect(verdict.message).toBe(
        "storage quota is set (1024 bytes) but the studio database is unavailable, so storage usage cannot be checked; submissions are blocked (fail-closed posture)",
      );
    });

    it(`${label}: a throwing read fails CLOSED 503 carrying the underlying error`, async () => {
      const db = fakeDb();
      db.failNext = "SELECT COALESCE(SUM(bytes)";
      const verdict = await checkStorageQuota({ DB: db, R2_STORAGE_QUOTA_BYTES: "1024", ...modeEnv });
      if (verdict.ok) throw new Error("expected a deny");
      expect(verdict.status).toBe(503);
      expect(verdict.message).toBe(
        "storage quota check failed (db exploded); submissions are blocked until the database recovers (fail-closed posture)",
      );
    });

    it(`${label}: under the ceiling allows, and the knob off never touches the database`, async () => {
      const db = fakeDb();
      await recordObjectWrite(db, "a", 400);
      const under = await checkStorageQuota({ DB: db, R2_STORAGE_QUOTA_BYTES: "1000", ...modeEnv });
      expect(under).toMatchObject({ ok: true, mode: "deny", usedBytes: 400, quotaBytes: 1000 });

      const off = fakeDb();
      const noKnob = await checkStorageQuota({ DB: off, ...modeEnv });
      expect(noKnob).toMatchObject({ ok: true, usedBytes: null, quotaBytes: null });
      expect(off.calls).toEqual([]);
    });
  }
});

describe("cp#195 meter mode", () => {
  it("does NOT deny at or over the included quota, and reports the real numbers", async () => {
    const db = fakeDb();
    await markStorageLedgerTrue(db);
    await recordObjectWrite(db, "a", 4096);
    const verdict = await checkStorageQuota({
      DB: db,
      R2_STORAGE_QUOTA_BYTES: "1024",
      R2_STORAGE_QUOTA_MODE: "meter",
    });
    // No hard cap: this submit proceeds. The overage is somebody else to bill, not a refusal.
    expect(verdict).toMatchObject({
      ok: true,
      mode: "meter",
      usedBytes: 4096,
      quotaBytes: 1024,
      complete: true,
      reason: null,
    });
  });

  it("a BROKEN read is a metering gap, never a zero and never a deny", async () => {
    const db = fakeDb();
    db.failNext = "SELECT COALESCE(SUM(bytes)";
    const verdict = await checkStorageQuota({
      DB: db,
      R2_STORAGE_QUOTA_BYTES: "1024",
      R2_STORAGE_QUOTA_MODE: "meter",
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.complete).toBe(false);
    expect(verdict.usedBytes).toBeNull();
    expect(String(verdict.reason)).toContain("db exploded");
  });

  it("no database is a metering gap too, not a fail-closed deny", async () => {
    const verdict = await checkStorageQuota({ R2_STORAGE_QUOTA_BYTES: "1024", R2_STORAGE_QUOTA_MODE: "meter" });
    expect(verdict).toMatchObject({ ok: true, mode: "meter", complete: false, usedBytes: null });
    expect(String(verdict.reason)).toContain("database is unavailable");
  });

  // THE POINT OF THE FLAG. Before it, `{ ok: true, usedBytes: null }` was already the return for a
  // quota that is not configured at all, so a failed read was indistinguishable from an
  // unconfigured studio -- and billed as zero. These three must be three different answers.
  it("CONTROL: a real zero, a metering gap and an unconfigured quota are distinguishable", async () => {
    const empty = fakeDb();
    await markStorageLedgerTrue(empty);
    const realZero = await checkStorageQuota({
      DB: empty,
      R2_STORAGE_QUOTA_BYTES: "1024",
      R2_STORAGE_QUOTA_MODE: "meter",
    });
    expect(realZero).toMatchObject({ complete: true, usedBytes: 0, quotaBytes: 1024 });

    const broken = fakeDb();
    broken.failNext = "SELECT COALESCE(SUM(bytes)";
    const gap = await checkStorageQuota({
      DB: broken,
      R2_STORAGE_QUOTA_BYTES: "1024",
      R2_STORAGE_QUOTA_MODE: "meter",
    });
    expect(gap).toMatchObject({ complete: false, usedBytes: null, quotaBytes: 1024 });

    const unconfiguredDb = fakeDb();
    await markStorageLedgerTrue(unconfiguredDb);
    const unconfigured = await checkStorageQuota({ DB: unconfiguredDb, R2_STORAGE_QUOTA_MODE: "meter" });
    expect(unconfigured).toMatchObject({ complete: true, usedBytes: null, quotaBytes: null });

    // Pairwise different, which is the property a biller depends on.
    expect(realZero.usedBytes).not.toBe(gap.usedBytes);
    expect(gap.complete).not.toBe(unconfigured.complete);
    expect(realZero.quotaBytes).not.toBe(unconfigured.quotaBytes);
  });
});

describe("storageQuotaState (the observer surface)", () => {
  it("reports used, objects, the quota and the overage", async () => {
    const db = fakeDb();
    await markStorageLedgerTrue(db);
    await recordObjectWrite(db, "a", 1500);
    await recordObjectWrite(db, "b", 100);
    const state = await storageQuotaState({
      DB: db,
      R2_STORAGE_QUOTA_BYTES: "1000",
      R2_STORAGE_QUOTA_MODE: "meter",
    });
    expect(state).toEqual({
      mode: "meter",
      quotaBytes: 1000,
      usedBytes: 1600,
      objects: 2,
      overageBytes: 600,
      complete: true,
      reason: null,
    });
  });

  it("under the quota reports ZERO overage, not null", async () => {
    const db = fakeDb();
    await markStorageLedgerTrue(db);
    await recordObjectWrite(db, "a", 10);
    const state = await storageQuotaState({ DB: db, R2_STORAGE_QUOTA_BYTES: "1000" });
    // "nothing over" and "we do not know" are different answers.
    expect(state.overageBytes).toBe(0);
    expect(state.complete).toBe(true);
  });

  it("a broken read reports a gap with a null overage, never a zero one", async () => {
    const db = fakeDb();
    db.failNext = "SELECT COALESCE(SUM(bytes)";
    const state = await storageQuotaState({ DB: db, R2_STORAGE_QUOTA_BYTES: "1000" });
    expect(state).toMatchObject({ complete: false, usedBytes: null, objects: null, overageBytes: null });
    expect(String(state.reason)).toContain("db exploded");
  });

  it("no quota configured: a real reading with no overage to compute", async () => {
    const db = fakeDb();
    await markStorageLedgerTrue(db);
    await recordObjectWrite(db, "a", 42);
    const state = await storageQuotaState({ DB: db });
    expect(state).toMatchObject({ mode: "deny", quotaBytes: null, usedBytes: 42, overageBytes: null, complete: true });
  });
});

// ---------------------------------------------------------------- cp#195: is the ledger TRUE?
//
// Found by rollins while grounding the plane side, and it is the sharpest failure in this lane:
// storageUsedBytes() returns a confident integer on a studio whose ledger has never been
// reconciled, and that integer is a FLOOR. In `meter` mode that bills an overage computed from a
// total nobody can stand behind, in the direction that flatters us, and nothing downstream can
// catch it because a low number and a correct number are the same shape.
describe("cp#195: a readable total is not a TRUE total", () => {
  it("an unestablished ledger is UNBILLABLE in meter mode, numbers and all", async () => {
    const db = fakeDb();
    await recordObjectWrite(db, "a", 4096);
    const verdict = await checkStorageQuota({
      DB: db,
      R2_STORAGE_QUOTA_BYTES: "1024",
      R2_STORAGE_QUOTA_MODE: "meter",
    });
    // The submit still proceeds: meter never denies. But the reading is not a billing basis.
    expect(verdict.ok).toBe(true);
    expect(verdict.complete).toBe(false);
    expect(String(verdict.reason)).toContain("FLOOR");
    // The number is still REPORTED. An operator looking at a usage page wants the floor rather
    // than a blank; it is the completeness pair that says what it rests on.
    expect(verdict.usedBytes).toBe(4096);
  });

  it("stamping the ledger makes it billable, and reconcile stamps it", async () => {
    const stamped = fakeDb();
    await markStorageLedgerTrue(stamped);
    await recordObjectWrite(stamped, "a", 4096);
    const afterStamp = await checkStorageQuota({
      DB: stamped,
      R2_STORAGE_QUOTA_BYTES: "1024",
      R2_STORAGE_QUOTA_MODE: "meter",
    });
    expect(afterStamp).toMatchObject({ complete: true, reason: null, usedBytes: 4096 });

    // A reconcile is the other way a ledger becomes true, and it must not need a separate call.
    const reconciled = fakeDb();
    const bucket = fakeBucket();
    bucket.objects.set("a", 4096);
    await reconcileStorageUsage(bucket, reconciled);
    expect(await storageLedgerTrueSince(reconciled)).not.toBeNull();
    const afterReconcile = await checkStorageQuota({
      DB: reconciled,
      R2_STORAGE_QUOTA_BYTES: "1024",
      R2_STORAGE_QUOTA_MODE: "meter",
    });
    expect(afterReconcile).toMatchObject({ complete: true, reason: null });
  });

  it("storageLedgerTrueSince reads null when the table does not exist yet, rather than throwing", async () => {
    // The table is created where it is WRITTEN, so a studio that has never stamped anything has no
    // table at all. That must read as "not established", not as an exception, and not as true.
    const db = fakeDb();
    expect(db.metaTableExists).toBe(false);
    expect(await storageLedgerTrueSince(db)).toBeNull();
  });

  // CONTROL: the failure this whole flag exists to prevent. An unreconciled ledger and a
  // reconciled one holding the same bytes must NOT produce the same billing verdict.
  it("CONTROL: an unestablished ledger and an established one differ, on identical bytes", async () => {
    const mkEnv = (DB: FakeDb) => ({
      DB,
      R2_STORAGE_QUOTA_BYTES: "1024",
      R2_STORAGE_QUOTA_MODE: "meter",
    });
    const cold = fakeDb();
    await recordObjectWrite(cold, "a", 4096);
    const warm = fakeDb();
    await markStorageLedgerTrue(warm);
    await recordObjectWrite(warm, "a", 4096);

    const a = await checkStorageQuota(mkEnv(cold));
    const b = await checkStorageQuota(mkEnv(warm));
    expect(a.usedBytes).toBe(b.usedBytes);
    // Same number, different standing. If these ever agree, the flag has stopped doing its job.
    expect(a.complete).not.toBe(b.complete);
  });

  it("DENY decisions are untouched by the ledger rule: a floor still denies", async () => {
    const db = fakeDb();
    await recordObjectWrite(db, "a", 2000);
    const verdict = await checkStorageQuota({ DB: db, R2_STORAGE_QUOTA_BYTES: "1000" });
    if (verdict.ok) throw new Error("expected a deny");
    // Byte-identical: same status, same message. Only the advisory pair reports the weaker basis.
    expect(verdict.status).toBe(507);
    expect(verdict.message).toBe(
      "storage quota reached: 2000 bytes stored of the 1000-byte R2_STORAGE_QUOTA_BYTES ceiling; delete renders or raise the knob",
    );
    expect(verdict.complete).toBe(false);
  });

  it("the observer surface reports the floor AND says it is one", async () => {
    const db = fakeDb();
    await recordObjectWrite(db, "a", 1500);
    const state = await storageQuotaState({ DB: db, R2_STORAGE_QUOTA_BYTES: "1000" });
    expect(state).toMatchObject({ usedBytes: 1500, overageBytes: 500, complete: false });
    expect(String(state.reason)).toContain("FLOOR");
  });
});

describe("isStorageSubmitRoute", () => {
  it("gates the byte-writing POST routes", () => {
    for (const path of [
      "/api/upload",
      "/api/storyboard/render",
      "/api/render/film",
      "/api/render/clips",
      "/api/storyboard/renders/abc-123/finalize",
      "/api/cast/7/train-wan-lora",
      "/api/cast/7/portrait",
      "/api/storyboard/score-bed",
    ]) {
      expect(isStorageSubmitRoute("POST", path), path).toBe(true);
    }
  });

  it("ignores non-POST and the documented exclusions", () => {
    expect(isStorageSubmitRoute("GET", "/api/upload")).toBe(false);
    expect(isStorageSubmitRoute("DELETE", "/api/storyboard/render")).toBe(false);
    // Documented bounds: planning/chat spend AI money (a different meter) but store no artifact.
    for (const path of ["/api/chat", "/api/storyboard/plan", "/api/storyboard/refine", "/api/storyboard/enhance", "/api/storyboard/preflight"]) {
      expect(isStorageSubmitRoute("POST", path), path).toBe(false);
    }
    // Not a prefix match: a longer path must not slip through a pattern.
    expect(isStorageSubmitRoute("POST", "/api/upload/extra")).toBe(false);
    expect(isStorageSubmitRoute("POST", "/api/storyboard/renders/a/b/finalize")).toBe(false);
  });

  it("exposes the pattern list as a COPY (a caller cannot mutate the gate)", () => {
    const list = storageSubmitPatterns();
    expect(list.length).toBeGreaterThan(10);
    list.length = 0;
    expect(storageSubmitPatterns().length).toBeGreaterThan(10);
  });
});

describe("putValueByteLength", () => {
  it("measures the shapes a host actually puts", () => {
    expect(putValueByteLength("abc")).toBe(3);
    // UTF-8, not UTF-16 code units: a 1-char emoji is 4 bytes on the wire.
    expect(putValueByteLength("\u{1F3AC}")).toBe(4);
    expect(putValueByteLength(new Uint8Array(9))).toBe(9);
    expect(putValueByteLength(new ArrayBuffer(11))).toBe(11);
    expect(putValueByteLength({ body: new Uint8Array(5) })).toBe(5);
  });

  it("returns null (not 0) for a shape it cannot measure", () => {
    expect(putValueByteLength(undefined)).toBeNull();
    expect(putValueByteLength({ streaming: true })).toBeNull();
  });
});

// ---------------------------------------------------------------- metered store fakes

function fakeBucket(): R2Bucket & { objects: Map<string, number>; putCalls: number } {
  const objects = new Map<string, number>();
  const bucket = {
    objects,
    putCalls: 0,
    async get() {
      return null;
    },
    async put(key: string, value: unknown) {
      bucket.putCalls += 1;
      objects.set(key, putValueByteLength(value) ?? 0);
    },
    async head(key: string) {
      const size = objects.get(key);
      return size === undefined ? null : { size };
    },
    async list() {
      return { objects: [...objects.entries()].map(([key, size]) => ({ key, size })), truncated: false };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    // A host-specific method the core does not know about: it must survive the wrapper.
    hostOnlyMethod() {
      return "still here";
    },
  };
  return bucket as unknown as R2Bucket & { objects: Map<string, number>; putCalls: number };
}

describe("metered store (the write seam)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("accounts every put and every delete", async () => {
    const db = fakeDb();
    const bucket = meteredR2Bucket(fakeBucket(), db);
    await bucket.put("renders/a.mp4", new Uint8Array(500));
    await bucket.put("renders/b.mp4", "hello");
    expect(await storageUsedBytes(db)).toBe(505);
    await bucket.delete("renders/a.mp4");
    expect(await storageUsedBytes(db)).toBe(5);
  });

  it("re-putting a key updates the accounted size instead of adding to it", async () => {
    const db = fakeDb();
    const bucket = meteredR2Bucket(fakeBucket(), db);
    // The film/clip job docs are written to the SAME key on every advance tick; this is the case that
    // would inflate a naive counter into wedging a studio at its own ceiling.
    for (let i = 0; i < 10; i += 1) await bucket.put("films/job.json", new Uint8Array(120));
    expect(await storageUsedBytes(db)).toBe(120);
    expect((await storageUsage(db)).objects).toBe(1);
  });

  it("wrapping is IDEMPOTENT: a re-wrapped bucket does not double count", async () => {
    const db = fakeDb();
    const once = meteredR2Bucket(fakeBucket(), db);
    const twice = meteredR2Bucket(once, db);
    expect(twice).toBe(once);
    expect(isMeteredStore(twice)).toBe(true);
    await twice.put("a", new Uint8Array(64));
    expect(await storageUsedBytes(db)).toBe(64);
  });

  it("passes through methods the core does not know about", async () => {
    const bucket = meteredR2Bucket(fakeBucket(), fakeDb()) as unknown as { hostOnlyMethod(): string };
    expect(bucket.hostOnlyMethod()).toBe("still here");
  });

  it("PRESERVES the host store type, not just the host store methods", async () => {
    // A host store is a SUPERSET of the ICD (the Node ArtifactStore adds getBytes/getRange), and the
    // wrapper is a pass-through Proxy, so a host method must still WORK through the wrapper. This is the
    // RUNTIME half of that promise. The compile-time half cannot live here: `npm run typecheck` covers
    // src only, so a type assertion in a test file would pass whatever the signature said. It is
    // asserted in src/storage-quota.ts instead (PreservesStoreType).
    const store = meteredObjectStore(
      {
        async get() {
          return null;
        },
        async put() {},
        async head() {
          return null;
        },
        async delete() {},
        async getRange(): Promise<Uint8Array> {
          return new Uint8Array(3);
        },
      },
      fakeDb(),
    );
    expect((await store.getRange()).byteLength).toBe(3);
  });

  it("HEADs the store when the payload shape cannot be measured locally", async () => {
    const db = fakeDb();
    const inner = fakeBucket();
    // A put whose value the core cannot size, but which the store can report after the fact.
    inner.put = async (key: string) => {
      inner.objects.set(key, 777);
    };
    const bucket = meteredR2Bucket(inner, db);
    await bucket.put("streamed", { streaming: true } as unknown as string);
    expect(await storageUsedBytes(db)).toBe(777);
  });

  it("a BROKEN meter never fails the write (it warns and drifts low)", async () => {
    const db = fakeDb();
    db.failNext = "INSERT INTO storage_usage";
    const inner = fakeBucket();
    const bucket = meteredR2Bucket(inner, db);
    await expect(bucket.put("a", new Uint8Array(10))).resolves.toBeUndefined();
    // The OBJECT was written; only the accounting failed.
    expect(inner.objects.get("a")).toBe(10);
    expect(await storageUsedBytes(db)).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to account a write"));
  });

  it("a broken meter never fails a delete either", async () => {
    const db = fakeDb();
    const inner = fakeBucket();
    const bucket = meteredR2Bucket(inner, db);
    await bucket.put("a", new Uint8Array(10));
    db.failNext = "DELETE FROM storage_usage WHERE object_key = ?";
    await expect(bucket.delete("a")).resolves.toBeUndefined();
    expect(inner.objects.has("a")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to account a delete"));
  });

  it("meters an ObjectStore (the Node / MinIO door) the same way", async () => {
    const db = fakeDb();
    const objects = new Map<string, number>();
    const store = meteredObjectStore(
      {
        async get() {
          return null;
        },
        async put(key: string, value: ArrayBuffer | Uint8Array | string) {
          objects.set(key, putValueByteLength(value) ?? 0);
        },
        async head(key: string) {
          const size = objects.get(key);
          return size === undefined ? null : { size };
        },
        async delete(key: string) {
          objects.delete(key);
        },
      },
      db,
    );
    await store.put("renders/x.mp4", new Uint8Array(2048));
    expect(await storageUsedBytes(db)).toBe(2048);
    await store.delete("renders/x.mp4");
    expect(await storageUsedBytes(db)).toBe(0);
  });

  it("an UNWRAPPED store is not metered (the negative control)", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    expect(isMeteredStore(bucket)).toBe(false);
    await bucket.put("a", new Uint8Array(10));
    expect(await storageUsedBytes(db)).toBe(0);
  });
});

describe("reconcileStorageUsage (backfill + drift repair)", () => {
  it("rebuilds the ledger from the store, including artifacts that predate accounting", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    // Objects written BEFORE accounting existed: present in the store, absent from the ledger.
    bucket.objects.set("renders/old-1.mp4", 1000);
    bucket.objects.set("renders/old-2.mp4", 2000);
    expect(await storageUsedBytes(db)).toBe(0);
    const report = await reconcileStorageUsage(bucket, db);
    expect(report).toEqual({ objects: 2, bytes: 3000, unsized: 0 });
    expect(await storageUsedBytes(db)).toBe(3000);
  });

  it("DROPS ledger rows for objects that no longer exist (lifecycle expiry drift)", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    await recordObjectWrite(db, "renders/expired.mp4", 5000);
    bucket.objects.set("renders/live.mp4", 42);
    await reconcileStorageUsage(bucket, db);
    expect(await storageUsedBytes(db)).toBe(42);
    expect(db.rows.has("renders/expired.mp4")).toBe(false);
  });

  it("HEADs objects whose size the listing omits, and reports the ones it still cannot size", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    bucket.objects.set("sized-by-head", 300);
    // A host whose list() omits size (ICD-optional) plus one object the store will not describe at all.
    bucket.list = async () => ({
      objects: [{ key: "sized-by-head" }, { key: "ghost" }],
      truncated: false,
    });
    const report = await reconcileStorageUsage(bucket, db);
    expect(report.objects).toBe(2);
    expect(report.bytes).toBe(300);
    // The unmeasurable object is reported, NOT quietly folded into the total as a guess.
    expect(report.unsized).toBe(1);
  });

  it("follows pagination rather than accounting only the first page", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    const pages: Record<string, { objects: Array<{ key: string; size: number }>; truncated: boolean; cursor?: string }> = {
      "": { objects: [{ key: "a", size: 1 }], truncated: true, cursor: "a" },
      a: { objects: [{ key: "b", size: 2 }], truncated: true, cursor: "b" },
      b: { objects: [{ key: "c", size: 4 }], truncated: false },
    };
    bucket.list = async (opts: { prefix: string; cursor?: string }) => pages[opts.cursor ?? ""];
    const report = await reconcileStorageUsage(bucket, db);
    expect(report.objects).toBe(3);
    expect(await storageUsedBytes(db)).toBe(7);
  });

  it("a prefix-scoped reconcile only clears rows under that prefix", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    await recordObjectWrite(db, "cast/1/portrait.png", 900);
    await recordObjectWrite(db, "renders/stale.mp4", 100);
    bucket.objects.set("renders/fresh.mp4", 50);
    bucket.list = async (opts: { prefix: string }) =>
      opts.prefix === "renders/"
        ? { objects: [{ key: "renders/fresh.mp4", size: 50 }], truncated: false }
        : { objects: [], truncated: false };
    await reconcileStorageUsage(bucket, db, { prefix: "renders/" });
    // The cast row is untouched; the stale renders row is gone; the live one is accounted.
    expect(db.rows.get("cast/1/portrait.png")).toBe(900);
    expect(db.rows.has("renders/stale.mp4")).toBe(false);
    expect(await storageUsedBytes(db)).toBe(950);
  });

  it("chunks its writes (a big studio must not go out as one oversized batch)", async () => {
    const db = fakeDb();
    const batches: number[] = [];
    db.batch = async (stmts) => {
      batches.push(stmts.length);
      for (const s of stmts) await s.run();
      return [];
    };
    const bucket = fakeBucket();
    for (let i = 0; i < 250; i += 1) bucket.objects.set(`k${i}`, 1);
    const report = await reconcileStorageUsage(bucket, db, { chunkSize: 100 });
    expect(report.objects).toBe(250);
    // Three staging chunks, then the cf#516 swap as ONE batch of four statements (drop the old
    // rows, promote the staged ones, clear the scratch, re-stamp). The swap being a single batch is
    // the atomicity guarantee, so its size is pinned rather than left to drift.
    expect(batches).toEqual([100, 100, 50, 4]);
    expect(await storageUsedBytes(db)).toBe(250);
  });
});

describe("STORAGE_USAGE_DDL", () => {
  it("is the one schema both hosts migrate to", () => {
    expect(STORAGE_USAGE_DDL).toContain("CREATE TABLE IF NOT EXISTS storage_usage");
    expect(STORAGE_USAGE_DDL).toContain("object_key TEXT PRIMARY KEY");
    expect(STORAGE_USAGE_DDL).toContain("bytes INTEGER NOT NULL");
    expect(STORAGE_USAGE_DDL).toContain("updated_at INTEGER NOT NULL");
  });
});

// --------------------------------------------------------------- cf#516: partial rebuild
//
// A reconcile used to DELETE the ledger and then re-insert it. If the invocation died between those
// two steps the ledger was left neither the old state nor the new one -- and nothing said so,
// because `ledger_true_since` still carried the stamp from the PREVIOUS successful rebuild. So
// `storageQuotaState` reported `complete: true` about a ledger that was under-reporting: the
// completeness mechanism cp#195 built to keep "we read zero" and "we could not read" apart was
// CERTIFYING the one state it exists to catch, in the direction that under-bills. Measured before
// the fix: 39 of 40 injection points left the ledger stamped at a total that was never true,
// including 0 bytes.
//
// THE INVARIANT, stated deliberately without reference to how the rebuild is implemented:
//
//     a STAMPED ledger holds a total that was actually true at some instant.
//
// Intact-and-stamped is fine, incomplete-and-unstamped is fine, incomplete-and-stamped is the
// defect. Asserting the invariant rather than one injection point is what lets this survive a change
// of strategy; asserting "the stamp is null after a death" would pin one implementation and go green
// on a rebuild that never destroyed anything in the first place.
//
// The seam is a db whose Nth ledger write throws, which is what a platform-terminated invocation
// looks like from inside the module: no application error, just a call that does not return.

/** A statement that touches the ledger or its stamp, i.e. one whose loss can corrupt state. */
function isLedgerWrite(norm: string): boolean {
  return /^(INSERT INTO|DELETE FROM) storage_usage/.test(norm);
}

/**
 * Wrap a fake db so the Nth ledger-affecting write throws, as a killed invocation would.
 * `atomicBatch` models D1, where `batch()` is one transaction: it applies wholly or not at all.
 */
function dieOnWrite(db: FakeDb, nth: number, opts?: { atomicBatch?: boolean }): FakeDb {
  const realPrepare = db.prepare.bind(db);
  let writes = 0;
  // Statements issued from INSIDE a batch must not be injected into individually, or the "atomic"
  // batch is interruptible half-way and the harness quietly models the opposite of what it claims.
  // This bit cost a real debugging round: the atomic sweep reported one partial ledger, and it was
  // the instrument, not the code.
  let insideBatch = false;
  const wrap = (s: PreparedStatement, norm: string): PreparedStatement => ({
    bind: (...v: unknown[]) => wrap(s.bind(...v), norm),
    first: <T,>() => s.first<T>(),
    all: <T,>() => s.all<T>(),
    async run() {
      if (!insideBatch && isLedgerWrite(norm)) {
        writes += 1;
        if (writes === nth) throw new Error("Worker exceeded resource limits");
      }
      return s.run();
    },
  });
  db.prepare = (sql: string) => {
    const norm = sql.replace(/\s+/g, " ").trim();
    return wrap(realPrepare(sql), norm);
  };
  if (opts?.atomicBatch) {
    db.batch = async (stmts: PreparedStatement[]) => {
      // D1 runs a batch inside an implicit transaction, so a failure rolls the whole batch back.
      // Model that by counting the batch as ONE write and applying it all-or-nothing.
      writes += 1;
      if (writes === nth) throw new Error("Worker exceeded resource limits");
      insideBatch = true;
      try {
        for (const s of stmts) await s.run();
      } finally {
        insideBatch = false;
      }
      return [];
    };
  }
  return db;
}

describe("cf#516: a partial rebuild must never leave the ledger CERTIFIED", () => {
  const SEED_TOTAL = 31375; // sum 1..250
  const EXTRA = 100000; // one object added after the seed, so a COMPLETE rebuild has its own total
  const COMPLETE_TOTAL = SEED_TOTAL + EXTRA;
  /** Past the longest write sequence either host produces, so the sweep covers every phase. */
  const SWEEP = 300;

  /** A studio whose ledger is complete and STAMPED (i.e. billable), then an object arrives. */
  async function seededStudio() {
    const db = fakeDb();
    const bucket = fakeBucket();
    for (let i = 1; i <= 250; i += 1) bucket.objects.set(`renders/k${i}.mp4`, i);
    await reconcileStorageUsage(bucket, db);
    bucket.objects.set("renders/new.mp4", EXTRA);
    return { db, bucket };
  }

  it("CONTROL: the fake keeps the ledger and the staging table APART", async () => {
    // "storage_usage" is a PREFIX of "storage_usage_rebuild", so a mis-ordered dispatch arm in the
    // fake would make staging write straight into the ledger and every assertion below would pass
    // about a rebuild that never staged anything.
    const db = fakeDb();
    await db.prepare(STORAGE_REBUILD_DDL).bind().run();
    await db
      .prepare("INSERT INTO storage_usage_rebuild (object_key, bytes, updated_at) VALUES (?, ?, ?)")
      .bind("staged", 7, 1)
      .run();
    expect(db.rebuild.get("staged")).toBe(7);
    expect(db.rows.has("staged")).toBe(false);
  });

  it("CONTROL: the seeded studio is complete and billable before anything goes wrong", async () => {
    const { db } = await seededStudio();
    expect(await storageUsedBytes(db)).toBe(SEED_TOTAL);
    expect(await storageLedgerTrueSince(db)).not.toBeNull();
    const state = await storageQuotaState({ DB: db, R2_STORAGE_QUOTA_BYTES: "999999999", R2_STORAGE_QUOTA_MODE: "meter" });
    expect(state.complete).toBe(true);
  });

  it("CONTROL: an uninterrupted rebuild picks the new object up and stays billable", async () => {
    const { db, bucket } = await seededStudio();
    await reconcileStorageUsage(bucket, db, { chunkSize: 100 });
    expect(await storageUsedBytes(db)).toBe(COMPLETE_TOTAL);
    expect(await storageLedgerTrueSince(db)).not.toBeNull();
    expect(db.rebuild.size).toBe(0); // the scratch table is emptied on the way out
  });

  /** Run one full sweep of injection points and classify how each run ended. */
  async function sweep(atomicBatch: boolean) {
    let intact = 0;
    let incomplete = 0;
    let complete = 0;
    let unstamped = 0;
    const violations: string[] = [];
    for (let nth = 1; nth <= SWEEP; nth += 1) {
      const { db, bucket } = await seededStudio();
      try {
        await reconcileStorageUsage(bucket, dieOnWrite(db, nth, { atomicBatch }), { chunkSize: 100 });
        complete += 1;
      } catch {
        /* the invocation died, which is the case under test */
      }
      const used = await storageUsedBytes(db);
      const stamped = (await storageLedgerTrueSince(db)) !== null;
      if (!stamped) unstamped += 1;
      if (used === SEED_TOTAL) intact += 1;
      else if (used !== COMPLETE_TOTAL) incomplete += 1;
      if (stamped && used !== SEED_TOTAL && used !== COMPLETE_TOTAL) {
        violations.push(`death at write ${nth}: ledger STAMPED at ${used} bytes, which was never true`);
      }
    }
    return { intact, incomplete, complete, unstamped, violations };
  }

  it("INVARIANT, host with NO batch (Node/SQLite): partial is possible, certified-partial is not", async () => {
    const r = await sweep(false);
    // DENOMINATORS, so a clean result cannot be a sweep that never reached the dangerous phase.
    expect(r.intact).toBeGreaterThan(0); // deaths during staging destroy nothing
    expect(r.complete).toBeGreaterThan(0); // the sweep runs past the end of the write sequence
    expect(r.unstamped).toBeGreaterThan(0); // the invalidate step is really reached
    // Without transactions the swap CAN be interrupted, so a partial ledger is reachable here...
    expect(r.incomplete).toBeGreaterThan(0);
    // ...and every one of them is unstamped. That is the guarantee this host gets.
    expect(r.violations).toEqual([]);
  });

  it("INVARIANT, host with ATOMIC batch (D1/Workers): the ledger is never partial at all", async () => {
    const r = await sweep(true);
    expect(r.intact).toBeGreaterThan(0);
    expect(r.complete).toBeGreaterThan(0);
    expect(r.unstamped).toBeGreaterThan(0);
    // The stronger guarantee: the swap is one transaction, so no interruption leaves a partial
    // ledger. Not merely "no violations" -- the corrupt state is unreachable.
    expect(r.incomplete).toBe(0);
    expect(r.violations).toEqual([]);
  });

  it("an interrupted rebuild reports a metering GAP, never a smaller confident total", async () => {
    // Find an injection point that actually leaves the ledger neither old nor new.
    let found = 0;
    for (let nth = 1; nth <= SWEEP; nth += 1) {
      const { db, bucket } = await seededStudio();
      try {
        await reconcileStorageUsage(bucket, dieOnWrite(db, nth), { chunkSize: 100 });
      } catch {
        /* expected */
      }
      const used = await storageUsedBytes(db);
      if (used === SEED_TOTAL || used === COMPLETE_TOTAL) continue;
      found += 1;
      const state = await storageQuotaState({
        DB: db,
        R2_STORAGE_QUOTA_BYTES: "999999999",
        R2_STORAGE_QUOTA_MODE: "meter",
      });
      expect(state.complete).toBe(false);
      expect(state.reason).toMatch(/floor|true/i);
      const verdict = await checkStorageQuota({ DB: db, R2_STORAGE_QUOTA_BYTES: "999999999" });
      expect(verdict.complete).toBe(false);
    }
    // Not a vacuous pass: the loop must really have found interrupted-and-incomplete ledgers.
    expect(found).toBeGreaterThan(0);
  });
});

describe("cf#516: a rebuild that cannot finish REFUSES instead of half-running", () => {
  it("refuses before deleting anything, and says nothing was deleted", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    for (let i = 1; i <= 250; i += 1) bucket.objects.set(`renders/k${i}.mp4`, i);
    await reconcileStorageUsage(bucket, db); // establish a good, stamped ledger
    const before = await storageUsedBytes(db);
    expect(before).toBe(31375);

    // A budget far below what 250 objects need on a host with no batch (one call per row).
    await expect(reconcileStorageUsage(bucket, db, { subrequestBudget: 20 })).rejects.toThrow(
      StorageReconcileTooLargeError,
    );
    // THE POINT: the refusal is not a partial run. The ledger is untouched and still billable.
    expect(await storageUsedBytes(db)).toBe(before);
    expect(await storageLedgerTrueSince(db)).not.toBeNull();
  });

  it("the refusal carries the numbers an operator needs, and names the remedy", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    for (let i = 1; i <= 250; i += 1) bucket.objects.set(`renders/k${i}.mp4`, i);
    const err = await reconcileStorageUsage(bucket, db, { subrequestBudget: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageReconcileTooLargeError);
    expect(err.budget).toBe(20);
    expect(err.projectedCalls).toBeGreaterThan(20);
    expect(err.message).toMatch(/NOTHING WAS DELETED/);
    expect(err.message).toMatch(/prefix/);
  });

  it("refuses DURING enumeration too, before a single row is staged", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    // A store that would page forever: the budget is what stops it.
    bucket.list = async () => ({ objects: [{ key: "k", size: 1 }], truncated: true, cursor: "next" });
    await expect(reconcileStorageUsage(bucket, db, { subrequestBudget: 5 })).rejects.toThrow(
      /still listing/,
    );
    expect(db.rebuild.size).toBe(0);
    expect(db.rows.size).toBe(0);
  });

  it("CONTROL: a studio comfortably inside the budget is not refused", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    for (let i = 1; i <= 250; i += 1) bucket.objects.set(`renders/k${i}.mp4`, i);
    // The default budget must not fire on an ordinary studio: a guard that refuses correct work is
    // the guard people switch off.
    const report = await reconcileStorageUsage(bucket, db, { chunkSize: 100 });
    expect(report.objects).toBe(250);
    expect(await storageLedgerTrueSince(db)).not.toBeNull();
  });
});
