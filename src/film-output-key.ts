// Deterministic assembled-film key + resolution helpers shared by the film orchestrator,
// poll bridge, and renders DB backfill (#99: COMPLETED row with film.mp4 in store but output_key null).

import type { Env } from "./platform/orchestrator-context.js";
import type { FilmJob } from "./film-model.js";

/** Canonical R2 key for a single-film concat output (matches enterAssemblePhase). */
export function defaultFilmOutputKey(filmId: string): string {
  return `renders/${filmId}/film.mp4`;
}

/** Does this job owe the user a single assembled film at all?
 *
 *  FALSE for the two shapes that are complete WITHOUT one, because they deliver something else:
 *  a keyframes-only render (the stills are the deliverable), and an assemble degrade that shipped
 *  per-shot clips (`finish_unavailable.delivered === "clips"`, #519).
 *
 *  Split out of resolveFilmOutputKey because an `undefined` key used to mean BOTH "no film is owed"
 *  and "a film is owed and this doc does not know its key". Those two need OPPOSITE handling at the
 *  done transition (one is a clean completion, the other is a failed render), so they can no longer
 *  share one return value. (vivijure-cf#833) */
export function filmDeliverableExpected(job: FilmJob): boolean {
  if (job.keyframes_only) return false;
  if (job.finish_unavailable?.delivered === "clips") return false;
  return true;
}

/** Resolve the deliverable film key from an in-memory job doc. NO store probe: this reports only
 *  what the doc actually RECORDS, and the caller decides what an absent key means.
 *
 *  It used to end with `return defaultFilmOutputKey(job.film_id)`, so the result was truthy for
 *  every job that was neither keyframes-only nor a clips degrade, whether or not anything had ever
 *  been written to that key. That guess was not merely a mislabelled row: BOTH R2-existence heals
 *  are guarded on this value being FALSY (`transitionToDone` -> `adoptFilmOutputKeyFromStore`, and
 *  the COMPLETED backfill in `renders-db.ts` -> the same helper), so a key that is always truthy
 *  made both of them unreachable. The two checks written to catch a COMPLETED row with no artifact
 *  were disabled by the helper feeding them. (vivijure-cf#833)
 *
 *  The deterministic key is still the right thing to GUESS; guessing belongs in
 *  `adoptFilmOutputKeyFromStore`, which HEADs the store before it adopts anything. */
export function resolveFilmOutputKey(job: FilmJob): string | undefined {
  if (typeof job.film_key === "string" && job.film_key.length > 0) return job.film_key;
  if (typeof job.silent_film_key === "string" && job.silent_film_key.length > 0) return job.silent_film_key;
  return undefined;
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
