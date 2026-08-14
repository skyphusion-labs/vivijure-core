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

import type { Database, ObjectStore, PreparedStatement } from "./platform/types.js";
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
  /** "deny" (the default) or "meter"; unset / empty / unrecognised = "deny". See storageQuotaMode. */
  R2_STORAGE_QUOTA_MODE?: unknown;
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

// --------------------------------------------------------------------------- the mode knob

/**
 * What the ceiling MEANS (cp#195).
 *
 * - `deny`   -- the number is a HARD CEILING. Submit is refused at it, with the honest 507 and the
 *               real numbers. This is what core#52 shipped and it is the DEFAULT.
 * - `meter`  -- the number is an INCLUDED QUOTA. Nothing is refused; the studio surfaces
 *               used-vs-included and whoever is billing meters the overage.
 *
 * Both ship to hosted and self-host in the same release, for the same reason the quota itself did:
 * an enforcement posture that exists only for hosted is the drift tripwire this feature was built to
 * avoid. A self-hoster who wants an included-quota display without a hard stop gets the identical
 * behaviour the hosted tier runs on.
 */
export type StorageQuotaMode = "deny" | "meter";

/**
 * Resolve the mode. Unset, empty, or ANY unrecognised value resolves to `deny`.
 *
 * NOTE THE ASYMMETRY WITH THE BYTES KNOB, which is deliberate and not an inconsistency to tidy up.
 * For `R2_STORAGE_QUOTA_BYTES`, garbage means OFF: nobody set a ceiling, so there is no ceiling, and
 * absent knob means absent behaviour. For the MODE, garbage cannot mean "no mode" -- a studio with a
 * ceiling set still has to pick an enforcement posture -- so it means `deny`, the conservative side.
 * Guessing `meter` on a typo would silently turn a hard stop into unmetered spend, which is the one
 * direction that costs somebody money they did not agree to.
 *
 * An unrecognised value WARNS rather than throwing. Refusing to boot over a mode string would take a
 * studio down for a typo whose safe interpretation is obvious; going quiet would leave an operator
 * believing they configured metering. Loud and safe beats either.
 */
export function storageQuotaMode(env: StorageQuotaEnv): StorageQuotaMode {
  const raw = env.R2_STORAGE_QUOTA_MODE;
  if (typeof raw !== "string" || raw.trim() === "") return "deny";
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === "meter") return "meter";
  if (cleaned !== "deny") {
    console.warn(
      `storage-quota: R2_STORAGE_QUOTA_MODE is set to an unrecognised value; falling back to "deny" (the safe side). Valid values are "deny" and "meter".`,
    );
  }
  return "deny";
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

// --------------------------------------------------------------------------- is the ledger TRUE?

/**
 * Companion table recording WHEN this ledger started telling the truth (cp#195, found by rollins).
 *
 * THE PROBLEM IT SOLVES, and it is the exact failure `complete` exists to catch. `storageUsedBytes`
 * returns a confident integer on a studio whose ledger has never been reconciled, and that integer
 * is a FLOOR rather than a total:
 *
 *   - accounting starts at 0 on any studio that predates the version shipping it, because artifact
 *     sizes are not derivable from the DB and there is nothing honest to backfill (see the header);
 *   - a write it could not size or account leaves the counter reading LOW, with a warn;
 *   - a delete it could not account leaves it reading HIGH, with a warn.
 *
 * In `deny` mode a low counter merely denies later than it should. In `meter` mode it is a BILLING
 * DEFECT, and in the direction that flatters us: we under-count, so we under-bill, and the
 * cost-recovery ratio reports health. Nothing downstream can catch it, because a low number and a
 * correct number are the same shape. That is a guard that looks exactly like success.
 *
 * WHY "true since" AND NOT "last reconciled". A reconcile is one way a ledger becomes true; being
 * born with accounting already on is the other, and it is the case that covers every studio
 * provisioned from here. A host that creates a studio at or after this version can stamp it at
 * creation and the ledger is honest from birth with no reconcile ever run. Naming the fact rather
 * than the procedure keeps both in one field.
 *
 * WHY THE TABLE IS CREATED LAZILY rather than added to the panel migrations. The panels carry
 * STORAGE_USAGE_DDL verbatim with tests asserting their migration still matches it, so a second DDL
 * constant would put a migration in front of this train in two more repos. Creating it where it is
 * WRITTEN, and treating its absence as "not established" on read, needs no migration and fails in
 * the safe direction: a studio that has never stamped anything reads as unbillable rather than as
 * billable-at-a-floor. The constant is exported anyway, so a host that prefers a real migration can
 * carry it.
 */
export const STORAGE_LEDGER_META_DDL = `CREATE TABLE IF NOT EXISTS storage_usage_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

const LEDGER_TRUE_SINCE_KEY = "ledger_true_since";
const LEDGER_UNSIZED_KEY = "ledger_unsized_objects";

/**
 * Record that the ledger is true as of `atSeconds` (default now).
 *
 * Called by `reconcileStorageUsage` on every successful rebuild, and callable by a HOST at studio
 * creation to assert "this ledger has been accurate since the studio existed". The second caller is
 * the one that matters for new tenants: without it every fresh studio would read as unbillable
 * despite having a perfectly honest ledger.
 */
export async function markStorageLedgerTrue(db: Database, atSeconds?: number): Promise<void> {
  await db.prepare(STORAGE_LEDGER_META_DDL).bind().run();
  await db
    .prepare(
      `INSERT INTO storage_usage_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(LEDGER_TRUE_SINCE_KEY, String(atSeconds ?? nowSeconds()))
    .run();
}

/**
 * Record how many objects the last reconcile could NOT size (core#183 family).
 *
 * WHY THIS IS PERSISTED AT ALL: `reconcileStorageUsage` already returns `unsized` in its report,
 * and every caller discards it. So the fact that a total is a FLOOR rather than a TOTAL survived
 * exactly as long as the HTTP response, and afterwards a ledger built from objects the store
 * refused to size was byte-identical to an exact one -- same bytes, same object count, same
 * `complete`. An object accounted at 0 because it is empty and an object accounted at 0 because
 * nobody could measure it are different facts, and this is what keeps them different.
 *
 * ZERO IS A MEASUREMENT AND ABSENCE IS NOT. Writing 0 asserts "a reconcile looked and everything
 * sized cleanly"; an absent key means nobody has ever established it, which is the state every
 * studio stamped by a host at creation is in. Collapsing those two would assert an exactness no one
 * measured, which is the defect this exists to close rather than to re-create one field over.
 */
export async function markStorageLedgerUnsized(db: Database, unsized: number): Promise<void> {
  // Creates the table itself rather than depending on markStorageLedgerTrue having run first: an
  // ordering coupling between two writers of the same table is a trap for whoever calls one alone.
  await db.prepare(STORAGE_LEDGER_META_DDL).bind().run();
  await db
    .prepare(
      `INSERT INTO storage_usage_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(LEDGER_UNSIZED_KEY, String(Math.max(0, Math.floor(unsized))))
    .run();
}

/**
 * Objects the last reconcile could not size, or null when that has never been established.
 *
 * Read the pair, never one field: `0` means the accounted total is EXACT, a positive number means
 * it is a FLOOR by at least that many objects, and `null` means UNKNOWN. Any failure reads as null
 * for the same reason `storageLedgerTrueSince` does -- every failure mode here means "we cannot
 * establish this", and guessing 0 would be the one direction that claims an exactness we did not
 * measure.
 */
export async function storageLedgerUnsizedObjects(db: Database): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM storage_usage_meta WHERE key = ?")
      .bind(LEDGER_UNSIZED_KEY)
      .first<{ value: string | null }>();
    const n = Number(row?.value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Unix seconds since when this ledger is known true, or null when that has never been established.
 *
 * ANY failure reads as null, including the table simply not existing yet, and that is deliberate
 * rather than sloppy: every failure mode here means the same thing operationally, which is that we
 * cannot establish the ledger is complete. Guessing "true" on a read error would be the one
 * direction that bills a customer off a number we could not stand behind.
 */
export async function storageLedgerTrueSince(db: Database): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM storage_usage_meta WHERE key = ?")
      .bind(LEDGER_TRUE_SINCE_KEY)
      .first<{ value: string | null }>();
    const n = Number(row?.value);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- enforcement

export type StorageQuotaVerdict =
  | {
      ok: true;
      mode: StorageQuotaMode;
      usedBytes: number | null;
      quotaBytes: number | null;
      /** See the COMPLETENESS CONTRACT below. */
      complete: boolean;
      reason: string | null;
    }
  // 507 = an explicit over-quota verdict (the honest deny, real numbers in the message).
  // 503 = the quota is SET but its own check is broken (no DB / query threw): the money path fails
  //       CLOSED, exactly like the spend ceiling, because a novice self-funds the bill and must not
  //       silently run unmetered on a misconfigured studio.
  // NEITHER is reachable in `meter` mode: there is no deny to make, so there is nothing to fail
  // closed to. A broken read in `meter` mode is a METERING GAP, reported as complete:false.
  | {
      ok: false;
      status: 507 | 503;
      mode: StorageQuotaMode;
      usedBytes: number | null;
      quotaBytes: number;
      message: string;
      complete: boolean;
      reason: string | null;
    };

// COMPLETENESS CONTRACT (cp#195), the same vocabulary the LLM meter uses, deliberately:
//
//   complete: true   this answer is a usable basis for billing. usedBytes is a real reading.
//   complete: false  a METERING GAP. usedBytes is null and `reason` says why in words a human can
//                    act on. The period is UNBILLABLE. It is NEVER zero overage.
//
// The distinction is load-bearing in `meter` mode and it is why the flag exists at all. `meter` has
// no hard cap, so a silently broken storage read plus no cap is unbounded spend carried by whoever
// is billing. "We read zero" and "we could not read" must not arrive as the same value, and before
// this flag they did: `{ ok: true, usedBytes: null }` was ALREADY the return for a quota that is
// simply not configured (the pure no-op below), so a failed read would have been indistinguishable
// from an unconfigured studio, not merely from a real zero.
//
// Read the pair, never one field: `quotaBytes === null` means no quota is configured at all, which
// is a third state and not an incomplete one.

/**
 * Enforce (or merely observe) the storage ceiling for one submission.
 *
 * Knob off = a pure no-op that never touches the DB, in BOTH modes. That is not an optimisation to
 * be tidied away: submit is a hot-ish path and a studio with no quota configured has nothing to read.
 *
 * `deny` mode is byte-identical to core#52: same decisions, same statuses, same message text. The
 * added fields are additive and no consumer serialises this verdict; the panel reads `.ok`,
 * `.status` and `.message`. tests/storage-quota.test.ts pins all three across the whole matrix, so a
 * drift in the default is a test failure rather than a reading exercise.
 */
export async function checkStorageQuota(env: StorageQuotaEnv): Promise<StorageQuotaVerdict> {
  const mode = storageQuotaMode(env);
  const quotaBytes = storageQuotaBytes(env);
  if (quotaBytes === null) {
    return { ok: true, mode, usedBytes: null, quotaBytes: null, complete: true, reason: null };
  }

  if (!env.DB) {
    const reason = "the studio database is unavailable, so storage usage cannot be read";
    if (mode === "meter") {
      // No deny to make, so nothing to fail closed to. This is a metering gap and it is reported as
      // one: the submit proceeds and the period is unbillable.
      return { ok: true, mode, usedBytes: null, quotaBytes, complete: false, reason };
    }
    return {
      ok: false,
      status: 503,
      mode,
      usedBytes: null,
      quotaBytes,
      message: `storage quota is set (${quotaBytes} bytes) but the studio database is unavailable, so storage usage cannot be checked; submissions are blocked (fail-closed posture)`,
      complete: false,
      reason,
    };
  }

  let usedBytes: number;
  try {
    usedBytes = await storageUsedBytes(env.DB);
  } catch (e) {
    const reason = `the storage usage read failed (${(e as Error).message})`;
    if (mode === "meter") {
      return { ok: true, mode, usedBytes: null, quotaBytes, complete: false, reason };
    }
    return {
      ok: false,
      status: 503,
      mode,
      usedBytes: null,
      quotaBytes,
      message: `storage quota check failed (${(e as Error).message}); submissions are blocked until the database recovers (fail-closed posture)`,
      complete: false,
      reason,
    };
  }

  // >= denies AT the ceiling: a studio exactly at its limit is full, and the next render only ever adds
  // bytes. Denying one submission early is honest; letting one through is not.
  //
  // In `meter` mode this is not a ceiling at all, so there is no deny: the reading is complete, the
  // overage is real, and the submit proceeds.
  // A readable number is not the same as a trustworthy one. An unreconciled ledger returns a
  // confident integer that is a FLOOR, so in `meter` mode it would bill an overage computed from a
  // total we cannot stand behind, in the direction that flatters us. Establishing this costs one
  // extra read on a path that runs at submit, which is rare.
  const trueSince = await storageLedgerTrueSince(env.DB);
  if (trueSince === null) {
    const reason =
      "this studio storage ledger has never been established as true (no reconcile has run and no " +
      "host has stamped it), so the accounted total is a FLOOR rather than a total";
    if (mode === "meter") {
      return { ok: true, mode, usedBytes, quotaBytes, complete: false, reason };
    }
    // `deny` decisions are untouched: a floor still denies, just later than a true total would.
    // Only the advisory completeness pair reports the weaker basis.
    if (usedBytes >= quotaBytes) {
      return {
        ok: false,
        status: 507,
        mode,
        usedBytes,
        quotaBytes,
        message: `storage quota reached: ${usedBytes} bytes stored of the ${quotaBytes}-byte R2_STORAGE_QUOTA_BYTES ceiling; delete renders or raise the knob`,
        complete: false,
        reason,
      };
    }
    return { ok: true, mode, usedBytes, quotaBytes, complete: false, reason };
  }

  if (usedBytes >= quotaBytes && mode === "deny") {
    return {
      ok: false,
      status: 507,
      mode,
      usedBytes,
      quotaBytes,
      message: `storage quota reached: ${usedBytes} bytes stored of the ${quotaBytes}-byte R2_STORAGE_QUOTA_BYTES ceiling; delete renders or raise the knob`,
      complete: true,
      reason: null,
    };
  }
  return { ok: true, mode, usedBytes, quotaBytes, complete: true, reason: null };
}

/**
 * The OBSERVER surface: what the operator (and, for a hosted tenant, the biller) needs to see, with
 * no submit semantics attached. `checkStorageQuota` is the submit-time gate and runs on the render
 * path; this is the read behind the usage route and the used-vs-included display.
 *
 * ONE computation, deliberately. The alternative was for the hosted plane to compute the billable
 * number its own way from its own R2 read, which means two numbers can disagree about the same
 * tenant and the one that bills is the one nobody can see. A self-hoster reads the identical fact
 * off the identical surface.
 */
export interface StorageQuotaState {
  mode: StorageQuotaMode;
  /** In `deny` this is the CEILING; in `meter` it is the INCLUDED quota. null = not configured. */
  quotaBytes: number | null;
  usedBytes: number | null;
  objects: number | null;
  /**
   * Bytes beyond `quotaBytes`, floored at 0. null when it cannot be computed (no reading, or no
   * quota configured). A real reading at or under the quota is 0, never null: "nothing over" and
   * "we do not know" are different answers and this field keeps them different.
   */
  overageBytes: number | null;
  /** Same contract as the verdict: false = METERING GAP, unbillable, never zero overage. */
  complete: boolean;
  reason: string | null;
  /**
   * Objects the last reconcile could not size, accounted as 0 bytes (core#183 family).
   *
   *   0     the accounted total is EXACT
   *   n > 0 the total is a FLOOR: n objects are in it at 0 bytes because the store would not
   *         report their size (the Node/MinIO door omits sizes by design)
   *   null  UNKNOWN -- no reconcile has ever recorded it
   *
   * DELIBERATELY ORTHOGONAL TO `complete`. `complete` answers "could we read the ledger at all";
   * this answers "is what we read exact". A floor does NOT set `complete: false`, because whether a
   * floor is billable is a product decision about the Node/MinIO door and not one this module makes
   * on an operator's behalf. Reporting the state is the job; adjudicating it is not.
   */
  unsizedObjects: number | null;
}

export async function storageQuotaState(env: StorageQuotaEnv): Promise<StorageQuotaState> {
  const mode = storageQuotaMode(env);
  const quotaBytes = storageQuotaBytes(env);

  if (!env.DB) {
    return {
      mode,
      quotaBytes,
      usedBytes: null,
      objects: null,
      overageBytes: null,
      complete: false,
      reason: "the studio database is unavailable, so storage usage cannot be read",
      unsizedObjects: null,
    };
  }

  try {
    const { usedBytes, objects } = await storageUsage(env.DB);
    const trueSince = await storageLedgerTrueSince(env.DB);
    const unsizedObjects = await storageLedgerUnsizedObjects(env.DB);
    return {
      mode,
      quotaBytes,
      usedBytes,
      objects,
      // The numbers are reported either way -- an operator staring at a usage page wants to see the
      // floor rather than a blank -- but the completeness pair says what they rest on.
      overageBytes: quotaBytes === null ? null : Math.max(0, usedBytes - quotaBytes),
      complete: trueSince !== null,
      reason:
        trueSince !== null
          ? null
          : "this studio storage ledger has never been established as true (no reconcile has run " +
            "and no host has stamped it), so the accounted total is a FLOOR rather than a total",
      unsizedObjects,
    };
  } catch (e) {
    return {
      mode,
      quotaBytes,
      usedBytes: null,
      objects: null,
      overageBytes: null,
      complete: false,
      reason: `the storage usage read failed (${(e as Error).message})`,
      unsizedObjects: null,
    };
  }
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

/** Scratch table the rebuild STAGES into before it touches the live ledger (cf#516).
 *
 *  Created where it is written rather than in a migration, for the same reason
 *  STORAGE_LEDGER_META_DDL is (see there): this is rebuild-only scratch, and putting it in front of
 *  two panels' migration trains buys nothing. It is emptied on both sides of a rebuild, so a killed
 *  invocation leaves at most one bucket-sized scratch table behind and the next run clears it. */
export const STORAGE_REBUILD_DDL = `CREATE TABLE IF NOT EXISTS storage_usage_rebuild (
  object_key TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

/** Platform calls one reconcile may issue before it refuses (cf#516).
 *
 *  WHAT THE NUMBER MEANS, because a bare constant invites someone to "just raise it": on Workers a
 *  request may make 1000 subrequests, and EVERY store call and EVERY D1 call is one. 900 leaves the
 *  calling handler ~100 for its own work. It is not a performance tuning knob; it is the point past
 *  which the invocation is killed by the platform MID-REBUILD, which is the condition cf#516 is
 *  about. Raising it does not buy a bigger bucket, it buys a rebuild that dies later. */
export const DEFAULT_RECONCILE_SUBREQUEST_BUDGET = 900;

/** Thrown INSTEAD of starting a rebuild that cannot finish. Nothing has been deleted when this is
 *  raised, and the message says so, because the operator's first question is what it cost them. */
export class StorageReconcileTooLargeError extends Error {
  constructor(
    readonly objects: number,
    readonly projectedCalls: number,
    readonly budget: number,
    detail: string,
  ) {
    super(
      `storage-reconcile: refused before touching the ledger -- ${detail} needs ~${projectedCalls} ` +
        `platform calls against a budget of ${budget}. NOTHING WAS DELETED. Narrow the rebuild with ` +
        `a prefix, or raise subrequestBudget if this host has a higher ceiling.`,
    );
    this.name = "StorageReconcileTooLargeError";
  }
}

/** Rebuild the ledger from the object store itself: the repair for accounting drift and the backfill for
 *  artifacts that predate accounting. Host-neutral, reading the store through the Platform ICD (list +
 *  head), never a CF-specific bucket-usage API.
 *
 *  Operator-invokable, never automatic: it is O(objects) list/head calls, so a boot-time sweep would tax
 *  every cold start of every studio to fix a number that is usually already right.
 *
 *  cf#516 -- THE ORDER OF OPERATIONS IS THE SAFETY PROPERTY, so read it before rearranging:
 *
 *    1. ENUMERATE, counting platform calls as we go.
 *    2. REFUSE if the writes will not fit in what is left. Nothing has been destroyed at this point,
 *       so the expensive failure is converted into a loud one.
 *    3. STAGE every row into `storage_usage_rebuild`. This is the long, killable phase, and it
 *       touches nothing anyone reads.
 *    4. CLEAR the `ledger_true_since` stamp. The ledger is about to stop being true and the stamp
 *       must not outlive that.
 *    5. SWAP in ONE batch: drop the old rows, promote the staged ones, drop the scratch, re-stamp.
 *
 *  The earlier version did 5 as `DELETE` then a re-insert loop, and left the stamp from the PREVIOUS
 *  rebuild in place throughout. So a killed invocation left a ledger that was neither the old state
 *  nor the new one while `storageLedgerTrueSince` still certified it -- `complete: true` over an
 *  under-reporting total, which is the one direction that bills nobody and prompts nobody to look.
 *
 *  TWO GUARANTEES, and they are deliberately not the same strength:
 *
 *    ATOMICITY, only where the host gives it. `db.batch` is one transaction on D1, so step 5 has no
 *    observable middle. A host with no `batch` runs it sequentially and can be interrupted inside it.
 *
 *    DETECTABILITY, on every host, with no transaction required. Because the stamp is cleared at 4
 *    and restored only at the end of 5, ANY interruption from 4 onward leaves the ledger unstamped,
 *    and an unstamped ledger already reads as a metering GAP rather than as a total (cp#195). An
 *    absence never renders as a value.
 *
 *  THE COST, stated because it is a real one: an interrupted rebuild leaves the ledger UNBILLABLE
 *  even when the swap rolled back cleanly and the old rows are intact. We cannot tell that case from
 *  a half-applied one without transactions we do not have on every host, so it lands on the
 *  unbillable side, which is the side this file has always chosen. Re-running the reconcile restores
 *  the stamp. */
export async function reconcileStorageUsage(
  bucket: R2Bucket,
  db: Database,
  opts?: { prefix?: string; chunkSize?: number; subrequestBudget?: number },
): Promise<StorageReconcileReport> {
  const prefix = opts?.prefix ?? "";
  const chunkSize = opts?.chunkSize ?? 100;
  const budget = opts?.subrequestBudget ?? DEFAULT_RECONCILE_SUBREQUEST_BUDGET;
  const sized: Array<{ key: string; bytes: number }> = [];
  let unsized = 0;

  // Every store call and every DB call is a subrequest on Workers, so they come out of one budget.
  let spent = 0;
  const scope = prefix ? `the rebuild under "${prefix}"` : "a whole-bucket rebuild";

  let cursor: string | undefined;
  do {
    spent += 1;
    if (spent > budget) {
      throw new StorageReconcileTooLargeError(sized.length, spent, budget, `${scope} (still listing)`);
    }
    const page = await bucket.list({ prefix, cursor });
    for (const obj of page.objects as ListedWithSize[]) {
      let bytes = typeof obj.size === "number" ? obj.size : null;
      if (bytes === null) {
        // A host whose list() omits size (ICD-optional): pay for one HEAD per object rather than
        // reporting a number we did not measure.
        spent += 1;
        if (spent > budget) {
          throw new StorageReconcileTooLargeError(sized.length, spent, budget, `${scope} (still sizing objects)`);
        }
        const head = await bucket.head(obj.key);
        bytes = head && typeof head.size === "number" ? head.size : null;
      }
      if (bytes === null) unsized += 1;
      sized.push({ key: obj.key, bytes: bytes ?? 0 });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // A host with batch writes one call per chunk; without it, one per row. That is why an unsized
  // host refuses so much earlier, and it is derived from what this host actually offers rather than
  // assumed.
  const fillCalls = db.batch ? Math.ceil(sized.length / chunkSize) : sized.length;
  const swapCalls = db.batch ? 1 : 5;
  const projected = spent + 2 /* create + clear scratch */ + fillCalls + 2 /* create meta + clear stamp */ + swapCalls;
  if (projected > budget) {
    throw new StorageReconcileTooLargeError(sized.length, projected, budget, `${scope} of ${sized.length} objects`);
  }

  const now = nowSeconds();

  // STAGE. Nothing below this comment is read by anyone until the swap, so an invocation killed
  // during the fill -- the long phase, and the one that grows with the bucket -- destroys nothing.
  await db.prepare(STORAGE_REBUILD_DDL).bind().run();
  await db.prepare("DELETE FROM storage_usage_rebuild").bind().run();
  const stage = db.prepare(
    `INSERT INTO storage_usage_rebuild (object_key, bytes, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(object_key) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at`,
  );
  for (let i = 0; i < sized.length; i += chunkSize) {
    const chunk = sized.slice(i, i + chunkSize).map((row) => stage.bind(row.key, row.bytes, now));
    if (db.batch) await db.batch(chunk);
    else for (const stmt of chunk) await stmt.run();
  }

  // INVALIDATE. From here the ledger is about to stop being true, so the stamp goes first: it is
  // restored at the end of the swap and nowhere else.
  //
  // The unsized COUNT is cleared in the SAME statement, deliberately. A count left behind from the
  // PREVIOUS rebuild would describe data this one is about to replace, so a new stamp could land
  // beside an old exactness claim -- which is this defect one field over rather than a fix for it.
  // The two facts are only meaningful together, so they are invalidated together and restored
  // together.
  await db.prepare(STORAGE_LEDGER_META_DDL).bind().run();
  await db
    .prepare("DELETE FROM storage_usage_meta WHERE key IN (?, ?)")
    .bind(LEDGER_TRUE_SINCE_KEY, LEDGER_UNSIZED_KEY)
    .run();

  // SWAP. Replace, do not merge: the store is the authority, so a ledger row for an object that no
  // longer exists (lifecycle-expired, deleted out of band) must disappear rather than survive a
  // reconcile. One batch, so on D1 there is no observable state between the old ledger and the new.
  const swap: PreparedStatement[] = [
    prefix
      ? db.prepare("DELETE FROM storage_usage WHERE object_key LIKE ? || '%'").bind(prefix)
      : db.prepare("DELETE FROM storage_usage").bind(),
    db
      .prepare(
        `INSERT INTO storage_usage (object_key, bytes, updated_at)
         SELECT object_key, bytes, updated_at FROM storage_usage_rebuild`,
      )
      .bind(),
    db.prepare("DELETE FROM storage_usage_rebuild").bind(),
    // The rebuild just made this ledger true; record that, because nothing else can observe it after
    // the fact. A total and a floor are the same shape (cp#195).
    db
      .prepare(
        `INSERT INTO storage_usage_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(LEDGER_TRUE_SINCE_KEY, String(now)),
    // ...and HOW MANY objects went in unmeasured, in the same batch as the stamp so the pair cannot
    // be torn apart. The report below carries `unsized` and every caller drops it, so without this
    // the floor-ness of the total dies with the HTTP response. Written unconditionally, INCLUDING
    // 0, because 0 is a measurement and absence is not.
    db
      .prepare(
        `INSERT INTO storage_usage_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(LEDGER_UNSIZED_KEY, String(Math.max(0, Math.floor(unsized)))),
  ];
  if (db.batch) await db.batch(swap);
  else for (const stmt of swap) await stmt.run();

  return {
    objects: sized.length,
    bytes: sized.reduce((sum, row) => sum + row.bytes, 0),
    unsized,
  };
}
