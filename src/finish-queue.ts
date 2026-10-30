/**
 * First-in-first-out admission to the video-finish tier.
 *
 * THE DEFECT. A door with no free instance answers 429 and core#367 made that a wait, retried with
 * backoff. Retry has no order: when a slot frees, whichever film polls next takes it, so a film can
 * wait behind newer ones for as long as newer ones keep arriving.
 *
 * WHY A TABLE AND NOT A DURABLE OBJECT OR A QUEUE. Cloudflare Queues give delivery, not slot leasing:
 * ordering is documented as best effort, delivery is at least once, and there is no position to read.
 * A coordinator Durable Object would serve one panel only, since the local panel has none. The
 * `Database` seam exists on both, it already carries the same claim pattern (film-advance-lease.ts),
 * and one implementation means the panels cannot drift. A Durable Object's alarm would buy nothing
 * here, since the sweep already drives every ask. The seam stays open: a host may bind its own queue.
 *
 * FAIRNESS, OPTIONAL. A ticket may carry an opaque key, and the queue may be given a cap on the slots
 * one key can hold, so a batch or a heavy project cannot take every slot while others wait. With no
 * cap, or no key, this is plain FIFO. Order within a key is always FIFO. A waiter whose key is at its
 * cap does not hold up anyone behind it, because it could not take a slot anyway.
 *
 * WHAT A TICKET IS. One row per film or scatter job, keyed by that id. `seq` is assigned at the first
 * ask and NEVER changes while the row lives, so a film keeps its place between assemble, mux and
 * film.finish: a slot is held for one job at a time, and the place in line is held for the whole film.
 *
 *   waiting  asked, not granted. Eligible when free slots exceed the live waiters ahead of it.
 *   leased   holds a slot until release, or until `lease_expires` passes.
 *   parked   holds no slot and is not asking. Keeps `seq` for its next ask.
 *
 * NOTHING HERE CAN WEDGE THE QUEUE, and each way out has a test:
 *   - A holder that crashes stops renewing, so its lease expires and the row goes back to waiting.
 *   - A waiter that stops asking goes stale and is skipped, without losing `seq` if it returns.
 *   - All state is in the table, so a worker restart loses nothing.
 *   - Expiry runs on every ask, so it needs no alarm, cron or background process.
 *
 * THE DOOR STAYS AUTHORITATIVE. `slots` is an estimate of what the door can run: an instance can
 * still be asleep after its job ended, and a self-host may run fewer than the default. A 429 after a
 * grant is a `yield`, which returns the slot, keeps `seq`, and lowers a temporary cap to what is
 * actually running. Without that cap, every waiter behind the head would be granted a slot the door
 * then refuses, and the next one to poll after a real slot frees would win, which is the unfairness
 * this exists to remove.
 */
import type { Database, PreparedStatement } from "./platform/types.js";
import { withD1Retry } from "./d1-retry.js";

/** Slot-holders the studio's container door can run: 20 instances, less one for synchronous calls. */
export const FINISH_QUEUE_DEFAULT_SLOTS = 19;
/**
 * A lease not renewed for this long is treated as a crashed holder. Renewal happens on each poll
 * tick, and the sweep reaches every row within a rotation, so this sits well above a rotation. If
 * it is ever too short the failure is benign: a live job loses its lease, the next film is
 * granted, and the door refuses it if it is really full.
 */
export const FINISH_QUEUE_LEASE_SECONDS = 20 * 60;
/** A waiter silent this long does not hold up the line. It keeps `seq` if it comes back. */
export const FINISH_QUEUE_STALE_SECONDS = 10 * 60;
/** How long a door refusal lowers the cap. Matches the longest capacity backoff. */
export const FINISH_QUEUE_CAP_COOLDOWN_SECONDS = 300;
/** Rows with no live claim are deleted after this long. Longer than the sweep's reach. */
export const FINISH_QUEUE_PRUNE_SECONDS = 48 * 3600;

/**
 * The schema, for a host's migration. A host test compares its migration to this, so the two cannot
 * drift. `seq` is AUTOINCREMENT so a pruned row's number is never reused and order stays strict.
 */
export const FINISH_QUEUE_SCHEMA = `CREATE TABLE IF NOT EXISTS finish_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  holder TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'leased', 'parked')),
  step TEXT,
  fairness_key TEXT,
  asked_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  lease_expires INTEGER
);
CREATE INDEX IF NOT EXISTS idx_finish_queue_state_seq ON finish_queue (state, seq);
CREATE TABLE IF NOT EXISTS finish_queue_cap (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cap INTEGER NOT NULL,
  until INTEGER NOT NULL
);
`;

/** The answer to one ask. `position` is 1 for the next film to be served. */
export type FinishQueueAnswer =
  | { granted: true; asked_at: number; running: number }
  | { granted: false; asked_at: number; running: number; position: number; depth: number };

/**
 * The host seam. A host opts in by setting `FINISH_QUEUE` on the env it hands core; absent means
 * today's retry with backoff. A host may implement this differently, and `sqlFinishQueue` is the
 * implementation both shipped panels can use.
 */
export interface FinishQueue {
  /** Join the line, or re-ask from the existing place. Idempotent. Renews a lease already held. */
  acquire(holder: string, ask?: { step?: string; fairnessKey?: string }): Promise<FinishQueueAnswer>;
  /** A job is running. Holds the slot, and takes one if the lease lapsed or never existed. */
  renew(holder: string): Promise<void>;
  /** The door refused a granted holder. Returns the slot, keeps the place, lowers the cap. */
  yield(holder: string): Promise<void>;
  /** The job ended. Returns the slot and keeps the place for the film's next step. */
  release(holder: string): Promise<void>;
  /** The film is finished with the queue. Removes the row. */
  forget(holder: string): Promise<void>;
  /** The next waiters in order, so a driver can reach them first. */
  next(limit: number): Promise<string[]>;
  /** The holders of a slot. A slot frees only when its holder's tick sees the job end, so a driver
   *  reaches these before the waiters. Bounded by the slot count. */
  holders(): Promise<string[]>;
}

export interface SqlFinishQueueOptions {
  slots?: number;
  /** Most slots one fairness key may hold. Absent means no cap. */
  perKeyCap?: number;
  now?: () => number;
}

/** A slot count from a host var. Anything but a positive integer is the default, never zero. */
export function finishQueueSlots(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : FINISH_QUEUE_DEFAULT_SLOTS;
}

async function runAll(db: Database, stmts: PreparedStatement[]): Promise<void> {
  if (db.batch) {
    await withD1Retry(() => db.batch!(stmts), { label: "finish_queue" });
    return;
  }
  // Safe without a transaction: each statement is atomic alone, and the grant is one compare-and-set.
  for (const stmt of stmts) await withD1Retry(() => stmt.run(), { label: "finish_queue" });
}

const LEASED = `(SELECT COUNT(*) FROM finish_queue WHERE state = 'leased')`;

export function sqlFinishQueue(db: Database, opts: SqlFinishQueueOptions = {}): FinishQueue {
  const slots = opts.slots ?? FINISH_QUEUE_DEFAULT_SLOTS;
  const clock = opts.now ?? Date.now;
  const keyCap = opts.perKeyCap;
  // A waiter at its key's cap cannot take a slot, so it holds nobody up. Inlined as an integer the
  // constructor validated, not bound, so the no-cap statement stays the plain FIFO one.
  const capped = keyCap !== undefined && Number.isInteger(keyCap) && keyCap > 0;
  const blocksOthers = capped
    ? ` AND (w.fairness_key IS NULL OR (SELECT COUNT(*) FROM finish_queue l WHERE l.state = 'leased' AND l.fairness_key = w.fairness_key) < ${keyCap})`
    : "";
  // With a cap, order inside a key is strict even when slots are free for both.
  const noEarlierInKey = (staleBefore: number): string =>
    capped
      ? ` AND (fairness_key IS NULL OR NOT EXISTS (SELECT 1 FROM finish_queue e WHERE e.state = 'waiting' AND e.last_seen >= ${Math.trunc(staleBefore)} AND e.fairness_key = finish_queue.fairness_key AND e.seq < finish_queue.seq))`
      : "";
  const underKeyCap = capped
    ? ` AND (fairness_key IS NULL OR (SELECT COUNT(*) FROM finish_queue l WHERE l.state = 'leased' AND l.fairness_key = finish_queue.fairness_key) < ${keyCap})`
    : "";

  /** An expired lease goes back to waiting at its original `seq`, so a holder that comes back has its
   *  place, and the sweep finds it through `next` and can clear it if the job is gone. Its `last_seen` is
   *  already past the stale window, so it holds up nobody until it asks. Long-dead rows go. Runs first
   *  in every ask. */
  const reap = (now: number): PreparedStatement[] => [
    db.prepare(`UPDATE finish_queue SET state = 'waiting', lease_expires = NULL WHERE state = 'leased' AND lease_expires < ?`).bind(now),
    db.prepare(`DELETE FROM finish_queue WHERE state != 'leased' AND last_seen < ?`).bind(now - FINISH_QUEUE_PRUNE_SECONDS * 1000),
  ];

  return {
    async acquire(holder, ask) {
      const now = clock();
      const step = ask?.step;
      const key = ask?.fairnessKey;
      const staleBefore = now - FINISH_QUEUE_STALE_SECONDS * 1000;
      await runAll(db, [
        ...reap(now),
        db.prepare(
          `INSERT INTO finish_queue (holder, state, step, fairness_key, asked_at, last_seen) VALUES (?, 'waiting', ?, ?, ?, ?)
           ON CONFLICT(holder) DO UPDATE SET
             last_seen = excluded.last_seen,
             step = excluded.step,
             state = CASE WHEN finish_queue.state = 'parked' THEN 'waiting' ELSE finish_queue.state END,
             lease_expires = CASE WHEN finish_queue.state = 'leased' THEN ? ELSE finish_queue.lease_expires END`,
        ).bind(holder, step ?? null, key ?? null, now, now, now + FINISH_QUEUE_LEASE_SECONDS * 1000),
        // THE GRANT, one atomic compare-and-set: this holder is served when the running jobs plus the
        // live waiters ahead of it still leave a slot under the effective cap.
        db.prepare(
          `UPDATE finish_queue SET state = 'leased', lease_expires = ?
           WHERE holder = ? AND state = 'waiting'${underKeyCap}${noEarlierInKey(staleBefore)}
             AND ${LEASED}
               + (SELECT COUNT(*) FROM finish_queue w WHERE w.state = 'waiting' AND w.last_seen >= ?${blocksOthers}
                    AND w.seq < (SELECT seq FROM finish_queue WHERE holder = ?))
               < COALESCE((SELECT MIN(?, cap) FROM finish_queue_cap WHERE id = 1 AND until > ?), ?)`,
        ).bind(now + FINISH_QUEUE_LEASE_SECONDS * 1000, holder, staleBefore, holder, slots, now, slots),
      ]);
      const row = await withD1Retry(
        () =>
          db.prepare(
            `SELECT state, asked_at, ${LEASED} AS running,
               (SELECT COUNT(*) FROM finish_queue w WHERE w.state = 'waiting' AND w.seq < q.seq) AS ahead,
               (SELECT COUNT(*) FROM finish_queue w WHERE w.state = 'waiting') AS depth
             FROM finish_queue q WHERE holder = ?`,
          ).bind(holder).first<{ state: string; asked_at: number; running: number; ahead: number; depth: number }>(),
        { label: "finish_queue" },
      );
      if (!row) throw new Error(`finish_queue: no row for ${holder} after acquire`);
      if (row.state === "leased") return { granted: true, asked_at: row.asked_at, running: row.running };
      return { granted: false, asked_at: row.asked_at, running: row.running, position: row.ahead + 1, depth: row.depth };
    },

    async renew(holder) {
      const now = clock();
      await withD1Retry(
        () =>
          db.prepare(
            `INSERT INTO finish_queue (holder, state, asked_at, last_seen, lease_expires) VALUES (?, 'leased', ?, ?, ?)
             ON CONFLICT(holder) DO UPDATE SET state = 'leased', last_seen = excluded.last_seen, lease_expires = excluded.lease_expires`,
          ).bind(holder, now, now, now + FINISH_QUEUE_LEASE_SECONDS * 1000).run(),
        { label: "finish_queue" },
      );
    },

    async yield(holder) {
      const now = clock();
      await runAll(db, [
        db.prepare(`UPDATE finish_queue SET state = 'waiting', lease_expires = NULL, last_seen = ? WHERE holder = ? AND state = 'leased'`).bind(now, holder),
        // The door is full at what is running now. Never below 1, so the head can still probe.
        db.prepare(
          `INSERT INTO finish_queue_cap (id, cap, until) VALUES (1, MAX(1, ${LEASED}), ?)
           ON CONFLICT(id) DO UPDATE SET cap = excluded.cap, until = excluded.until`,
        ).bind(now + FINISH_QUEUE_CAP_COOLDOWN_SECONDS * 1000),
      ]);
    },

    async release(holder) {
      const now = clock();
      await withD1Retry(
        () =>
          db.prepare(`UPDATE finish_queue SET state = 'parked', lease_expires = NULL, last_seen = ? WHERE holder = ?`).bind(now, holder).run(),
        { label: "finish_queue" },
      );
    },

    async forget(holder) {
      await withD1Retry(() => db.prepare(`DELETE FROM finish_queue WHERE holder = ?`).bind(holder).run(), { label: "finish_queue" });
    },

    async next(limit) {
      const res = await withD1Retry(
        () =>
          db.prepare(`SELECT holder FROM finish_queue WHERE state = 'waiting' ORDER BY seq ASC LIMIT ?`).bind(limit).all<{ holder: string }>(),
        { label: "finish_queue" },
      );
      return res.results.map((r) => r.holder);
    },

    async holders() {
      const res = await withD1Retry(
        () => db.prepare(`SELECT holder FROM finish_queue WHERE state = 'leased' ORDER BY seq ASC`).all<{ holder: string }>(),
        { label: "finish_queue" },
      );
      return res.results.map((r) => r.holder);
    },
  };
}
