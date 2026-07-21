// Deterministic assembled-film key + resolution helpers shared by the film orchestrator,
// poll bridge, and renders DB backfill (#99: COMPLETED row with film.mp4 in store but output_key null).

import type { Env } from "./platform/orchestrator-context.js";
import type { FilmJob } from "./film-model.js";

/** Canonical R2 key for a single-film concat output (matches enterAssemblePhase). */
export function defaultFilmOutputKey(filmId: string): string {
  return `renders/${filmId}/film.mp4`;
}

/** Resolve the deliverable film key from an in-memory job doc (no store probe). */
export function resolveFilmOutputKey(job: FilmJob): string | undefined {
  if (typeof job.film_key === "string" && job.film_key.length > 0) return job.film_key;
  if (typeof job.silent_film_key === "string" && job.silent_film_key.length > 0) return job.silent_film_key;
  if (job.keyframes_only) return undefined;
  if (job.finish_unavailable?.delivered === "clips") return undefined;
  return defaultFilmOutputKey(job.film_id);
}

/** When the job doc lost film_key but the assembled artifact landed, adopt the deterministic key. */
export async function adoptFilmOutputKeyFromStore(
  env: Env,
  filmId: string,
): Promise<string | undefined> {
  const key = defaultFilmOutputKey(filmId);
  try {
    return (await env.R2_RENDERS.head(key)) !== null ? key : undefined;
  } catch {
    return undefined;
  }
}
