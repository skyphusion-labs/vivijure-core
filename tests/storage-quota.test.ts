import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  STORAGE_USAGE_DDL,
  checkStorageQuota,
  isMeteredStore,
  isStorageSubmitRoute,
  meteredObjectStore,
  meteredR2Bucket,
  putValueByteLength,
  recordObjectDelete,
  recordObjectWrite,
  reconcileStorageUsage,
  storageQuotaBytes,
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
  failNext?: string;
}

function fakeDb(): FakeDb {
  const rows = new Map<string, number>();
  const calls: string[] = [];
  const db = { rows, calls } as FakeDb;

  // D1 semantics: prepare() yields a statement, and bind() yields a NEW statement carrying ITS OWN
  // values, so one prepared statement can be bound many times (the pattern reconcile uses).
  const make = (norm: string, bound: unknown[]): PreparedStatement => ({
    bind(...values: unknown[]) {
      return make(norm, values);
    },
    async first<T>() {
      calls.push(norm);
      if (db.failNext && norm.includes(db.failNext)) throw new Error("db exploded");
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
      if (norm.startsWith("INSERT INTO storage_usage")) {
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
    expect(batches).toEqual([100, 100, 50]);
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
