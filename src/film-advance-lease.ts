import type { Env } from "./platform/orchestrator-context.js";
import { withD1Retry } from "./d1-retry.js";

/**
 * How long a claim holds the film with no renewal (vivijure-cf#1139).
 *
 * WHY SHORT, AND WHY A HEARTBEAT. The lease is released in the tick's `finally`. A host can end the
 * tick before that runs: a Worker's execution context ends when its client disconnects, and every
 * pending await in it is dropped, `finally` included. The lease then stayed held until it expired.
 * At 300 s a client that timed out each poll made a film advance one step per five minutes, and the
 * sweep lost every claim in that window too. Measured on two 8-shot keyframe films, 2026-10-31.
 *
 * So the lease now lives only as long as its holder does: it is short, and `holdFilmAdvance` renews it
 * every `FILM_ADVANCE_LEASE_RENEW_SECONDS` while the tick runs. A tick that is cut off stops renewing,
 * because its timers die with it, and the film is free again within this many seconds. A tick that
 * runs long keeps the film, so two drivers still never overlap.
 */
export const FILM_ADVANCE_LEASE_TTL_SECONDS = 60;

/** Renewal period. Three renewals fit in one TTL, so one failed renewal does not free a live tick. */
export const FILM_ADVANCE_LEASE_RENEW_SECONDS = 20;

export interface FilmAdvanceClaim {
  won: boolean;
  /** The lease EXPIRY (ms epoch): the wall-clock instant this claim's hold self-expires. Present
   *  only on a guarded win. Informational; the release key is `token`, not this value. */
  lease?: number;
  /** The per-claim leaseholder identity (a UUID), present only on a guarded win. This -- NOT the
   *  expiry timestamp -- is what identifies the holder, because the timestamp is NOT unique: CF's
   *  `Date.now()` is coarsened + frozen per-invocation, so two claims racing in the same
   *  millisecond compute the identical `lease` value. The token is what `releaseFilmAdvance` keys
   *  on, and what makes the claim idempotent under `withD1Retry` (see below). */
  token?: string;
}

export async function claimFilmAdvance(
  env: Env,
  filmId: string,
  now: number = Date.now(),
): Promise<FilmAdvanceClaim> {
  const lease = now + FILM_ADVANCE_LEASE_TTL_SECONDS * 1000;
  // #29: a UNIQUE per-claim identity, generated ONCE (outside the retry closure) so every retry of
  // THIS claim re-binds the SAME token. That is what fixes the non-idempotent-retry stall: if the
  // first UPDATE commits (row now holds `token`) but its response is lost -> classified transient ->
  // withD1Retry re-runs the UPDATE, the `advance_lease < now` predicate no longer matches (the lease
  // is now in the future), but `advance_lease_token = ?` DOES match my own committed token, so the
  // retry still returns `won: true`. The true holder no longer mistakes its own commit for a loss and
  // wedges the film for up to a TTL. Crucially the token is UNIQUE (a UUID), not the lease value, so a
  // genuine same-millisecond loser -- which computed a DIFFERENT token -- never matches this clause and
  // correctly loses (value-equality on `lease` alone would let it double-win; #29 wave-5 regression).
  const token = crypto.randomUUID();
  const res = await withD1Retry(() =>
    env.DB.prepare(
      `UPDATE renders SET advance_lease = ?, advance_lease_token = ?
     WHERE job_id = ? AND (advance_lease IS NULL OR advance_lease < ? OR advance_lease_token = ?)`,
    )
      .bind(lease, token, filmId, now, token)
      .run(),
  );
  if ((res.meta?.changes ?? 0) === 1) return { won: true, lease, token };
  const row = await withD1Retry(() =>
    env.DB.prepare(`SELECT 1 AS one FROM renders WHERE job_id = ?`).bind(filmId).first(),
  );
  // A row exists but we didn't take the lease -> a live holder owns it: we lose. No row at all ->
  // fail OPEN (a legacy/untracked advanceable film must not deadlock; #29 part 2 is host-owned --
  // every advanceable film should have a renders row so this path is unreachable in practice).
  return row ? { won: false } : { won: true };
}

export async function releaseFilmAdvance(env: Env, filmId: string, token: string): Promise<void> {
  // Release BY TOKEN, not by lease value: only the holder whose exact UUID is still in the row clears
  // it. A same-ms loser (or a later re-grant to a different driver) carries a different token, so a
  // stale release is a precise no-op and can never free another driver's live lease.
  await withD1Retry(() =>
    env.DB.prepare(
      `UPDATE renders SET advance_lease = NULL, advance_lease_token = NULL
       WHERE job_id = ? AND advance_lease_token = ?`,
    )
      .bind(filmId, token)
      .run(),
  );
}

/**
 * Push this holder's lease expiry forward. True while this token still holds the film. False means
 * another driver holds it now, or the row is gone: the tick goes on, but says so.
 */
export async function renewFilmAdvance(
  env: Env,
  filmId: string,
  token: string,
  now: number = Date.now(),
): Promise<boolean> {
  const lease = now + FILM_ADVANCE_LEASE_TTL_SECONDS * 1000;
  const res = await withD1Retry(() =>
    env.DB.prepare(`UPDATE renders SET advance_lease = ? WHERE job_id = ? AND advance_lease_token = ?`)
      .bind(lease, filmId, token)
      .run(),
  );
  return (res.meta?.changes ?? 0) === 1;
}

/** A running renewal. `stop()` is idempotent and must run before the release. */
export interface FilmAdvanceHold {
  stop(): void;
}

/**
 * Keep a won claim alive while its tick runs (vivijure-cf#1139). A claim with no token (fail-open, or
 * no renders row) has nothing to renew, so this does nothing for it.
 *
 * The timer is the point: it runs only while the host keeps the tick alive. When a host drops the
 * tick, the renewal stops with it and the lease expires on its own within one TTL.
 */
export function holdFilmAdvance(env: Env, filmId: string, claim: FilmAdvanceClaim): FilmAdvanceHold {
  const token = claim.token;
  if (!claim.won || token === undefined) return { stop() {} };
  let stopped = false;
  let reported = false;
  const timer = setInterval(() => {
    if (stopped) return;
    renewFilmAdvance(env, filmId, token).then(
      (held) => {
        if (!held && !stopped && !reported) {
          reported = true;
          console.warn(JSON.stringify({ ev: "film.advance_lease_lost", film_id: filmId }));
        }
      },
      (e: Error) => {
        console.warn(`film ${filmId}: advance lease renewal failed (${e.message}); retrying next period`);
      },
    );
  }, FILM_ADVANCE_LEASE_RENEW_SECONDS * 1000);
  // Node: a renewal timer must not keep a finished process alive. Workers timers have no unref.
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
