// Background cron sweep: advance film / scatter jobs that have no client polling.

import type { Env, ExecutionContext } from "./platform/orchestrator-context.js";
import { advanceFilmJob, filmJobDocKey } from "./film-orchestrator.js";
import { filmJobToPollView, isFilmJobId } from "./film-render-bridge.js";
import { advanceScatterJob, isScatterJobId } from "./scatter-orchestrator.js";
import {
  countStrandedPostClipsFilmJobs,
  countUnresolvedNotifiableJobs,
  listStrandedPostClipsFilmJobs,
  listUnresolvedNotifiableJobs,
  updateRenderFromView,
} from "./renders-db.js";

/** Max age for jobs the sweep still tries to resolve (24h, matches RunPod job TTL). */
export const SWEEP_MAX_AGE_SECONDS = 24 * 3600;

/** Cron cadence, in seconds. Only used to derive the rotating window index below. */
export const SWEEP_TICK_SECONDS = 60;

/** Rows one pass will handle in a single tick. Bounds tick cost; it is NOT a fairness knob. */
export const SWEEP_PAGE_SIZE = 25;

/**
 * Which page of the population this tick handles.
 *
 * WHY A ROTATION AND NOT A BIGGER CAP (core#180). Both passes were `ORDER BY submitted_at ASC
 * LIMIT 25` with no offset, so every tick re-read the same oldest page. MEASURED against the real
 * schema: with 40 unresolved films, ten consecutive ticks reached 25 of them and **15 were never
 * reached at all**; with 25 films that cannot resolve, the 15 behind them were not attempted once
 * in 100 ticks. Raising the cap only moves where the cliff is -- oldest-first with ANY cap starves
 * the tail, and the tail is the newest work, which is exactly what a load test or a beta tester is
 * waiting on.
 *
 * Rotating the window is starvation-free by construction: every row is handled once per
 * `ceil(total / limit)` ticks regardless of what the head of the queue is doing, so an
 * unresolvable row costs one slot for one tick per cycle instead of holding it forever.
 *
 * Least-recently-attempted would be the textbook answer. It is NOT available: `renders` carries no
 * attempt-history column (checked -- `advance_lease` is a mutual-exclusion lease that is set back
 * to NULL on release, and `updated_at` moves only on genuine progress, so a permanently stuck row
 * keeps an old stamp and would be re-selected forever). Adding one means a vivijure-cf migration,
 * which makes this fix cross-repo and no longer independently deployable. The rotation gets the
 * same starvation-freedom from a column that already exists plus the clock.
 *
 * `total === null` means the count could not be read. Rotation is DISABLED in that case, which is
 * exactly today's behaviour, and the null is reported in the coverage event rather than being
 * quietly rendered as 0 -- a total defaulting to 0 would disable rotation and simultaneously claim
 * full coverage, which is the reassuring reading of a broken instrument.
 */
export function rotatingOffset(total: number | null, limit: number, windowIndex: number): number {
  if (total === null || !Number.isFinite(total) || total <= limit || limit <= 0) return 0;
  const windows = Math.ceil(total / limit);
  const w = ((Math.trunc(windowIndex) % windows) + windows) % windows; // non-negative modulo
  return w * limit;
}

/** Wall-clock derived tick index. Monotonic, needs no persisted cursor and no new binding. */
function currentWindowIndex(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / SWEEP_TICK_SECONDS);
}

export async function sweepUnresolvedJobs(env: Env, ctx?: ExecutionContext): Promise<number> {
  const limit = SWEEP_PAGE_SIZE;
  const windowIndex = currentWindowIndex();

  // Pass 1: jobs young enough to still be live on RunPod (keyframe / clips can still
  // be polled). This is the common path.
  const total1 = await countUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS);
  const offset1 = rotatingOffset(total1, limit, windowIndex);
  const jobIds = await listUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS, limit, offset1);

  // Pass 2: post-clips film jobs that aged out of pass 1 but stalled before "done"
  // with their clips already rendered to R2. The remaining work (the CPU-only concat)
  // never expires, so we keep re-driving them -- gated on the film-job doc still
  // existing in R2 so we never chase a swept/GC'd job. De-dup against pass 1.
  const total2 = await countStrandedPostClipsFilmJobs(env, SWEEP_MAX_AGE_SECONDS);
  const offset2 = rotatingOffset(total2, limit, windowIndex);
  const seen = new Set(jobIds);
  const stranded: string[] = [];
  let docMissing = 0;
  for (const id of await listStrandedPostClipsFilmJobs(env, SWEEP_MAX_AGE_SECONDS, limit, offset2)) {
    if (seen.has(id) || !isFilmJobId(id)) continue;
    if (!(await filmJobDocExists(env, id))) {
      docMissing += 1; // counted, because a row nothing can ever close is its own finding
      continue;
    }
    seen.add(id);
    stranded.push(id);
  }

  let n = 0;
  let failed = 0;
  for (const jobId of [...jobIds, ...stranded]) {
    try {
      const handled = await resolveOneJob(env, jobId, ctx);
      if (handled) n += 1;
    } catch (e) {
      failed += 1;
      console.warn(`render sweep failed for ${jobId}: ${(e as Error).message}`);
    }
  }

  // Coverage, as a structured line rather than prose. Before this there was no metric anywhere
  // that could tell "swept and clean" from "never reached" (core#180 consequence 4), which is why
  // a starved tail produced no signal at all. `total_*: null` means UNMEASURED, never zero.
  console.log(
    "@event render_sweep " +
      JSON.stringify({
        window: windowIndex,
        limit,
        pass1: { total: total1, offset: offset1, returned: jobIds.length },
        pass2: { total: total2, offset: offset2, returned: stranded.length, doc_missing: docMissing },
        attempted: jobIds.length + stranded.length,
        handled: n,
        errors: failed,
      }),
  );

  return n;
}

/** Cheap presence check: a stranded film job is only worth re-driving if its job doc
 *  (which carries the finished clip keys) is still in R2. A swept doc means the clips
 *  are gone too -- nothing to assemble -- so we skip it. */
async function filmJobDocExists(env: Env, jobId: string): Promise<boolean> {
  try {
    return (await env.R2_RENDERS.head(filmJobDocKey(jobId))) !== null;
  } catch {
    return false;
  }
}

async function resolveOneJob(env: Env, jobId: string, ctx?: ExecutionContext): Promise<boolean> {
  if (isScatterJobId(jobId)) {
    const view = await advanceScatterJob(env, jobId, ctx);
    return view !== null;
  }
  if (isFilmJobId(jobId)) {
    const r = await advanceFilmJob(env, jobId);
    if (!r) return false;
    await updateRenderFromView(env, filmJobToPollView(r.job, r.clipJob), ctx);
    return true;
  }
  return false;
}
