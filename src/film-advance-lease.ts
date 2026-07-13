import type { Env } from "./platform/orchestrator-context.js";
import { withD1Retry } from "./d1-retry.js";

export const FILM_ADVANCE_LEASE_TTL_SECONDS = 300;

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
