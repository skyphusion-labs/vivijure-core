import type { Env } from "./platform/orchestrator-context.js";
import { withD1Retry } from "./d1-retry.js";

export const FILM_ADVANCE_LEASE_TTL_SECONDS = 300;

export interface FilmAdvanceClaim {
  won: boolean;
  lease?: number;
}

export async function claimFilmAdvance(
  env: Env,
  filmId: string,
  now: number = Date.now(),
): Promise<FilmAdvanceClaim> {
  const lease = now + FILM_ADVANCE_LEASE_TTL_SECONDS * 1000;
  const res = await withD1Retry(() =>
    env.DB.prepare(
      `UPDATE renders SET advance_lease = ?
     WHERE job_id = ? AND (advance_lease IS NULL OR advance_lease < ?)`,
    )
      .bind(lease, filmId, now)
      .run(),
  );
  if ((res.meta?.changes ?? 0) === 1) return { won: true, lease };
  const row = await withD1Retry(() =>
    env.DB.prepare(`SELECT 1 AS one FROM renders WHERE job_id = ?`).bind(filmId).first(),
  );
  return row ? { won: false } : { won: true };
}

export async function releaseFilmAdvance(env: Env, filmId: string, lease: number): Promise<void> {
  await withD1Retry(() =>
    env.DB.prepare(
      `UPDATE renders SET advance_lease = NULL WHERE job_id = ? AND advance_lease = ?`,
    )
      .bind(filmId, lease)
      .run(),
  );
}
