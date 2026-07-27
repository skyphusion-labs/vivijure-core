// Host-neutral storage accounting + the R2_STORAGE_QUOTA_BYTES operator knob (core#52).
//
// WHY THIS IS IN CORE, not in a panel: the hosted tier meters per-tenant storage, but a tenant studio
// runs the PUBLISHED release unmodified, so there is no hosted fork to put hosted-only enforcement in.
// A quota check that exists only for hosted is the named drift tripwire. It lands here as an operator
// knob shipping to hosted and self-host in the same release; hosted just sets the var per tenant, and a
// self-hoster gets the identical feature to cap their own R2 bill. Ruled on vivijure-cf#56.
//
// SHAPE (mirrors SPEND_DAILY_CEILING, vivijure-cf src/rate-limit.ts):
//   R2_STORAGE_QUOTA_BYTES="<n>"  -- unset / 0 / garbage = OFF (absent knob, absent behavior).
//                                    Set = enforced at submit with an HONEST deny carrying the real
//                                    numbers (used vs limit), never a silent truncation or a partial
//                                    render.
//
// WHERE THE NUMBER COMES FROM: the host DB, accounted at WRITE TIME (D1 on Workers, SQLite on the Node
// host). NOT an R2/S3 usage API read -- that is CF-specific, so it breaks the Node/MinIO host, which is
// a parity break for a parity feature; it is also eventually consistent and would need creds in the
// render path. The ledger is per object key (storage_usage), so re-writing the SAME key (every film /
// clip job-doc update does) UPDATES its row rather than double counting, and a delete removes it.
//
// ACCOUNTING RULE (one rule, no exceptions): every object write upserts its key at its current size,
// every delete (user, orphan-GC, panel cleanup) drops the row. Intermediates COUNT while they exist --
// they occupy bytes while they exist, and the operator is billed for them while they exist.
//
// ACCOUNTING NEVER FAILS A WRITE. The meter is a meter, not a gate: if the ledger write throws, the
// object write still succeeds and the counter drifts LOW with a warning. The gate is at submit. The
// repair for any drift (a failed ledger write, an R2 lifecycle rule expiring objects out of band, or
// artifacts that predate this version) is reconcileStorageUsage, which rebuilds the ledger from the
// object store itself.
//
// BACKFILL POSTURE (core#52 sub-question 1): artifact SIZES are not derivable from the DB (renders rows
// carry keys, never bytes), so there is nothing cheap and honest to sum. The counter therefore starts
// at 0 on an existing studio (accounting starts at the version that ships this) and the operator runs
// the reconcile to make the number true. That is stated in the docs and surfaced by the panel usage
// route, never left as a quietly-wrong number.

import type { Database, ObjectStore } from "./platform/types.js";
import type { R2Bucket } from "./platform/r2-types.js";

// --------------------------------------------------------------------------- schema

/** Canonical ledger DDL. Both panel migrations carry this VERBATIM, and each panel has a test asserting
 *  its migration file still matches this constant, so the two hosts cannot drift apart. */
export const STORAGE_USAGE_DDL = `CREATE TABLE IF NOT EXISTS storage_usage (
  object_key TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

// --------------------------------------------------------------------------- the knob

/** Env slice the quota needs. Structural, so both hosts pass their own bag (Workers Env / Platform
 *  vars) with no adapter. */
export interface StorageQuotaEnv {
  DB?: Database;
  /** Positive integer BYTES as a string; unset / 0 / garbage = quota off. */
  R2_STORAGE_QUOTA_BYTES?: unknown;
}

/** Pure: the configured ceiling in bytes, or null when the knob is off (unset / empty / 0 / garbage).
 *  Bytes only, deliberately: no "10GB" unit parsing, because a mis-parsed unit is an order-of-magnitude
 *  error on somebody's bill. The docs carry the worked examples. */
export function storageQuotaBytes(env: StorageQuotaEnv): number | null {
  const raw = env.R2_STORAGE_QUOTA_BYTES;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// --------------------------------------------------------------------------- the ledger

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Upsert one object's accounted size. Idempotent per key: a re-put of the same key overwrites its row,
 *  so repeated writes to a job doc never inflate the total. */
export async function recordObjectWrite(db: Database, key: string, bytes: number): Promise<void> {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`storage-usage: refusing to record ${bytes} bytes for ${key}`);
  }
  await db
    .prepare(
      `INSERT INTO storage_usage (object_key, bytes, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(object_key) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at`,
    )
    .bind(key, Math.floor(bytes), nowSeconds())
    .run();
}

/** Drop one object from the ledger. A key with no row is a no-op (deleting an unaccounted object is
 *  normal on a studio whose accounting started mid-life). */
export async function recordObjectDelete(db: Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM storage_usage WHERE object_key = ?").bind(key).run();
}

/** Accounted bytes AND object count, for enforcement and for the operator usage surface. One SUM over
 *  the ledger; called at submit (a rare event) and by the usage route, never on the write path. */
export async function storageUsage(db: Database): Promise<{ usedBytes: number; objects: number }> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(bytes), 0) AS total, COUNT(*) AS objects FROM storage_usage")
    .bind()
    .first<{ total: number | null; objects: number | null }>();
  return {
    usedBytes: typeof row?.total === "number" ? row.total : 0,
    objects: typeof row?.objects === "number" ? row.objects : 0,
  };
}

/** Total accounted bytes. */
export async function storageUsedBytes(db: Database): Promise<number> {
  return (await storageUsage(db)).usedBytes;
}

// --------------------------------------------------------------------------- enforcement

export type StorageQuotaVerdict =
  | { ok: true; usedBytes: number | null; quotaBytes: number | null }
  // 507 = an explicit over-quota verdict (the honest deny, real numbers in the message).
  // 503 = the quota is SET but its own check is broken (no DB / query threw): the money path fails
  //       CLOSED, exactly like the spend ceiling, because a novice self-funds the bill and must not
  //       silently run unmetered on a misconfigured studio.
  | { ok: false; status: 507 | 503; usedBytes: number | null; quotaBytes: number; message: string };

/** Enforce the storage ceiling for one submission. Knob off = a pure no-op that never touches the DB. */
export async function checkStorageQuota(env: StorageQuotaEnv): Promise<StorageQuotaVerdict> {
  const quotaBytes = storageQuotaBytes(env);
  if (quotaBytes === null) return { ok: true, usedBytes: null, quotaBytes: null };

  if (!env.DB) {
    return {
      ok: false,
      status: 503,
      usedBytes: null,
      quotaBytes,
      message: `storage quota is set (${quotaBytes} bytes) but the studio database is unavailable, so storage usage cannot be checked; submissions are blocked (fail-closed posture)`,
    };
  }

  let usedBytes: number;
  try {
    usedBytes = await storageUsedBytes(env.DB);
  } catch (e) {
    return {
      ok: false,
      status: 503,
      usedBytes: null,
      quotaBytes,
      message: `storage quota check failed (${(e as Error).message}); submissions are blocked until the database recovers (fail-closed posture)`,
    };
  }

  // >= denies AT the ceiling: a studio exactly at its limit is full, and the next render only ever adds
  // bytes. Denying one submission early is honest; letting one through is not.
  if (usedBytes >= quotaBytes) {
    return {
      ok: false,
      status: 507,
      usedBytes,
      quotaBytes,
      message: `storage quota reached: ${usedBytes} bytes stored of the ${quotaBytes}-byte R2_STORAGE_QUOTA_BYTES ceiling; delete renders or raise the knob`,
    };
  }
  return { ok: true, usedBytes, quotaBytes };
}

// --------------------------------------------------------------------------- the submit surface

// The POST routes that WRITE ARTIFACT BYTES: uploads, GPU submits, and the paid-generation routes whose
// product is a stored file. Both panels serve this same studio API, so the list lives here once rather
// than being mirrored (and drifting) in two hosts. Each panel has a test asserting every pattern below
// still matches one of ITS registered routes.
//
// Deliberately NOT here, and why:
//   /api/chat            -- its text branch writes nothing; only the image branch stores a small file.
//                           Denying text chat because the video bucket is full is over-blocking. The
//                           byte-heavy paths are all gated, and a full studio is denied at its next
//                           render submit. A documented bound, not an oversight.
//   /api/storyboard/plan | refine | enhance | preflight | render-plan | markers | yaml
//                        -- planning routes; they spend AI money (that is SPEND_DAILY_CEILING's job, a
//                           different meter) but store no artifact.
const STORAGE_SUBMIT_PATTERNS: RegExp[] = [
  // Operator/user uploads: caller-supplied bytes, the least bounded write there is.
  /^\/api\/upload$/,
  /^\/api\/storyboard\/audio-upload$/,
  /^\/api\/storyboard\/character-ref$/,
  /^\/api\/storyboard\/bundle$/,
  /^\/api\/cast\/import$/,
  /^\/api\/cast\/[^/]+\/portrait$/,
  /^\/api\/cast\/[^/]+\/ref$/,
  /^\/api\/cast\/[^/]+\/source$/,
  // GPU submits: every one of these ends in video / image / LoRA bytes in the bucket.
  /^\/api\/storyboard\/render$/,
  /^\/api\/storyboard\/render\/scatter$/,
  /^\/api\/storyboard\/render-from-keyframes$/,
  /^\/api\/render\/clips$/,
  /^\/api\/render\/film$/,
  /^\/api\/storyboard\/renders\/[^/]+\/regen-shot$/,
  /^\/api\/storyboard\/renders\/[^/]+\/finalize$/,
  /^\/api\/storyboard\/renders\/[^/]+\/animate-cloud$/,
  /^\/api\/storyboard\/renders\/[^/]+\/animate-hybrid$/,
  /^\/api\/storyboard\/renders\/[^/]+\/add-audio$/,
  /^\/api\/storyboard\/renders\/[^/]+\/add-narration$/,
  /^\/api\/cast\/[^/]+\/generate-refs$/,
  /^\/api\/cast\/[^/]+\/train-lora$/,
  /^\/api\/cast\/[^/]+\/train-wan-lora$/,
  // Audio generation: a score bed / music track is a stored artifact.
  /^\/api\/storyboard\/score-bed$/,
  /^\/api\/storyboard\/music-generate$/,
];

/** True for a request whose product is stored bytes, and so must pass the storage ceiling. */
export function isStorageSubmitRoute(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return STORAGE_SUBMIT_PATTERNS.some((re) => re.test(pathname));
}

/** The pattern list, for the panel route-drift tests. */
export function storageSubmitPatterns(): RegExp[] {
  return [...STORAGE_SUBMIT_PATTERNS];
}

// --------------------------------------------------------------------------- write metering

/** Marker so wrapping an already-metered store is a no-op. Symbol.for (not a fresh Symbol) so a double
 *  wrap ACROSS module instances (a panel copy plus the core copy) is still detected. A per-request seam
 *  that re-wrapped its bucket would otherwise double count every byte. */
const METERED = Symbol.for("vivijure.storage-metered");

/** Bytes a put() payload will occupy, or null when it cannot be determined from the value alone. */
export function putValueByteLength(value: unknown): number | null {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === "object" && value !== null && "body" in value) {
    const body = (value as { body?: unknown }).body;
    if (ArrayBuffer.isView(body)) return body.byteLength;
    if (body instanceof ArrayBuffer) return body.byteLength;
  }
  return null;
}

interface HeadLike {
  head?(key: string): Promise<{ size: number } | null>;
}

/** Account one completed write. Never throws: a broken meter must not fail a good write. */
async function accountWrite(db: Database, target: HeadLike, key: string, value: unknown): Promise<void> {
  try {
    let bytes = putValueByteLength(value);
    if (bytes === null && typeof target.head === "function") {
      // A payload shape we cannot measure locally (a stream, a host-specific body). Ask the store what
      // it actually stored rather than guessing or skipping.
      const head = await target.head(key);
      if (head && typeof head.size === "number") bytes = head.size;
    }
    if (bytes === null) {
      console.warn(`storage-usage: could not size ${key}; the counter will read LOW until a reconcile`);
      return;
    }
    await recordObjectWrite(db, key, bytes);
  } catch (e) {
    console.warn(
      `storage-usage: failed to account a write of ${key} (${(e as Error).message}); the counter may read LOW until a reconcile`,
    );
  }
}

/** Account one completed delete. Never throws (same reason as accountWrite). */
async function accountDelete(db: Database, key: string | string[]): Promise<void> {
  try {
    for (const k of Array.isArray(key) ? key : [key]) await recordObjectDelete(db, k);
  } catch (e) {
    console.warn(
      `storage-usage: failed to account a delete of ${String(key)} (${(e as Error).message}); the counter may read HIGH until a reconcile`,
    );
  }
}

function meterStoreLike<T extends object>(target: T, db: Database): T {
  if ((target as Record<symbol, unknown>)[METERED]) return target;
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop === METERED) return true;
      if (prop === "put") {
        return async (key: string, value: unknown, opts?: unknown): Promise<unknown> => {
          const put = Reflect.get(t, "put") as (k: string, v: unknown, o?: unknown) => Promise<unknown>;
          const result = await put.call(t, key, value, opts);
          await accountWrite(db, t as HeadLike, key, value);
          return result;
        };
      }
      if (prop === "delete") {
        return async (key: string | string[]): Promise<unknown> => {
          const del = Reflect.get(t, "delete") as (k: string | string[]) => Promise<unknown>;
          const result = await del.call(t, key);
          await accountDelete(db, key);
          return result;
        };
      }
      const value = Reflect.get(t, prop);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
  return proxy as T;
}

/** Wrap a Workers-shaped R2 bucket so every put/delete keeps the ledger current. Idempotent: wrapping an
 *  already-metered bucket returns it unchanged. Methods this core does not know about pass straight
 *  through, so a host binding keeps its full surface. */
export function meteredR2Bucket<T extends R2Bucket>(bucket: T, db: Database): T {
  return meterStoreLike(bucket, db);
}

/** Platform ICD twin of meteredR2Bucket, for a host whose renders store is an ObjectStore (the Node /
 *  MinIO door). Same accounting, same idempotence.
 *
 *  Generic in the store type because the wrapper is a pass-through Proxy: a host store that extends
 *  ObjectStore (the Node ArtifactStore adds getBytes/getRange) keeps its full surface, and the type says
 *  so rather than narrowing the caller down to the ICD subset. */
export function meteredObjectStore<T extends ObjectStore>(store: T, db: Database): T {
  return meterStoreLike(store, db);
}

// COMPILE-TIME GUARD for the two signatures above. It lives in src/ deliberately: `npm run typecheck`
// covers src only (tests/ is transpiled by vitest without being typechecked), so an assertion of this
// kind placed in a test file would pass no matter what the signature said -- exactly the class of
// invisible defect that motivated it. A non-generic wrapper narrows a host store down to the ICD subset
// and breaks the Node panel, which extends ObjectStore with getBytes/getRange; that must fail HERE, in
// core, rather than downstream after a release.
type PreservesStoreType<F> = F extends <T extends ObjectStore>(store: T, db: Database) => T ? true : never;
type PreservesBucketType<F> = F extends <T extends R2Bucket>(bucket: T, db: Database) => T ? true : never;
const _meteredObjectStorePreservesItsInput: PreservesStoreType<typeof meteredObjectStore> = true;
const _meteredR2BucketPreservesItsInput: PreservesBucketType<typeof meteredR2Bucket> = true;
void _meteredObjectStorePreservesItsInput;
void _meteredR2BucketPreservesItsInput;

/** True when this store already meters its writes (test + wiring assertions). */
export function isMeteredStore(store: object): boolean {
  return (store as Record<symbol, unknown>)[METERED] === true;
}

// --------------------------------------------------------------------------- reconcile

export interface StorageReconcileReport {
  /** Objects seen in the store. */
  objects: number;
  /** Total bytes written to the ledger. */
  bytes: number;
  /** Objects whose size the store would not report; accounted as 0 and reported honestly. */
  unsized: number;
}

interface ListedWithSize {
  key: string;
  size?: number;
}

/** Rebuild the ledger from the object store itself: the repair for accounting drift and the backfill for
 *  artifacts that predate accounting. Host-neutral, reading the store through the Platform ICD (list +
 *  head), never a CF-specific bucket-usage API.
 *
 *  Operator-invokable, never automatic: it is O(objects) list/head calls, so a boot-time sweep would tax
 *  every cold start of every studio to fix a number that is usually already right. */
export async function reconcileStorageUsage(
  bucket: R2Bucket,
  db: Database,
  opts?: { prefix?: string; chunkSize?: number },
): Promise<StorageReconcileReport> {
  const prefix = opts?.prefix ?? "";
  const chunkSize = opts?.chunkSize ?? 100;
  const sized: Array<{ key: string; bytes: number }> = [];
  let unsized = 0;

  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const obj of page.objects as ListedWithSize[]) {
      let bytes = typeof obj.size === "number" ? obj.size : null;
      if (bytes === null) {
        // A host whose list() omits size (ICD-optional): pay for one HEAD per object rather than
        // reporting a number we did not measure.
        const head = await bucket.head(obj.key);
        bytes = head && typeof head.size === "number" ? head.size : null;
      }
      if (bytes === null) unsized += 1;
      sized.push({ key: obj.key, bytes: bytes ?? 0 });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Replace, do not merge: the store is the authority, so a ledger row for an object that no longer
  // exists (lifecycle-expired, deleted out of band) must disappear rather than survive a reconcile.
  const deleteStmt = prefix
    ? db.prepare("DELETE FROM storage_usage WHERE object_key LIKE ? || '%'").bind(prefix)
    : db.prepare("DELETE FROM storage_usage").bind();
  await deleteStmt.run();

  const now = nowSeconds();
  const insert = db.prepare(
    `INSERT INTO storage_usage (object_key, bytes, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(object_key) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at`,
  );
  for (let i = 0; i < sized.length; i += chunkSize) {
    const chunk = sized.slice(i, i + chunkSize).map((row) => insert.bind(row.key, row.bytes, now));
    if (db.batch) await db.batch(chunk);
    else for (const stmt of chunk) await stmt.run();
  }

  return {
    objects: sized.length,
    bytes: sized.reduce((sum, row) => sum + row.bytes, 0),
    unsized,
  };
}
