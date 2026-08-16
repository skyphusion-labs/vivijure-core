// The ONE builder for the `renders.output_json` payload of a finished render.
//
// core#205: this column had FIVE writers and only ONE derived its payload. `markFinishDone` writes
// `output_json = ?` UNCONDITIONALLY (not COALESCE, unlike `output_ms` and `finish_elapsed_ms` in the
// same statement), so whichever site writes last in a tick wins the whole payload outright. A field
// added to the poll view alone was therefore ABSENT from the row anyone queries. That is not a
// hypothetical: it happened to cf#549's film_finish sidecar (core#203), and `keyframes_incomplete`
// was in exactly the same state until this file existed (in the view since it was added, never in
// the single-film finalize payload, and the finalize write is the LAST writer on that path).
//
// A hand-maintained duplicate of derivable truth drifts by construction. The fix is one function and
// no duplicate, so a field added once appears everywhere.
//
// ORDERING, stated here because until now it was convention and nothing in the codebase said it:
//   SINGLE FILM: `transitionToDone` -> `markFinishDone` is the LAST output_json writer of its tick.
//                Nothing re-writes the row afterwards until a later poll or sweep tick runs
//                `updateRenderFromView`.
//   SCATTER:     `finalizeScatterDone` -> `markFinishDone` runs FIRST, then `advanceScatterJob`'s
//                tail calls `updateRenderFromView(scatterJobToPollView(job))` -- so the VIEW writes
//                last on that path.
// The two paths write in OPPOSITE order. Scatter survived only because both of its writers happened
// to restate the same three keys; that is luck, not a contract. It is safe now because both writers
// on each path build their payload here, so whoever writes last writes the same bytes.
//
// Do not restore a hand-built payload object at any call site.
// `tests/render-output-json-writers-205.test.ts` drives a FULL advance tick on both paths and
// asserts the row against these builders, so a reintroduced duplicate reddens there.

import type { ClipJob } from "./render-orchestrator.js";
import type { FilmJob } from "./film-model.js";
import { clipDeliveries, filmFinishView, summarizeFinish } from "./film-model.js";
import { resolveFilmOutputKey } from "./film-output-key.js";
import type { ScatterJob } from "./scatter-orchestrator-types.js";

/** The `output_json` payload for a single-film job at phase `done`.
 *
 *  `clipJob` is the clip doc when the caller holds one. The poll view does. `transitionToDone` does
 *  NOT: it runs deep inside the advance tick, below the frame that read the clip doc, so it passes
 *  null and the two CLIP-DOC-derived enrichments (`clips`/`model` for a derive_mode render, and
 *  `clip_deliveries`) are omitted from its write. That asymmetry is deliberate, is the ONLY
 *  legitimate difference between the two writers, and a later poll or sweep `updateRenderFromView`
 *  backfills those two keys. Everything derived from the JOB doc alone is identical by construction:
 *  add a new field HERE, never at a call site. */
export function filmDonePayload(job: FilmJob, clipJob: ClipJob | null): Record<string, unknown> {
  const out: Record<string, unknown> = {
    output_key: resolveFilmOutputKey(job),
    project: job.project,
    mode: job.derive_mode ?? (job.keyframes_only ? "keyframes-only" : "full"),
  };
  if (job.film_finish?.sidecar_key) out.sidecar_key = job.film_finish.sidecar_key;
  // cf#1662: ALWAYS set, including null. The keys presence is what says this row was measured.
  out.film_finish = filmFinishView(job.film_finish);
  if (job.finish_unavailable) {
    out.finish_unavailable = {
      at: job.finish_unavailable.at,
      reason: job.finish_unavailable.reason,
      delivered: job.finish_unavailable.delivered,
    };
    const uClips = job.finish_unavailable.clips;
    if (uClips?.length) out.clips = uClips.map((c) => ({ shot_id: c.shot_id, key: c.clip_key }));
  }
  // #226: clip-level finish reasons on the SAME payload the panel already reads. Absent when the
  // film never entered a finish chain (keyframes-only, no finish modules). Present (including
  // degraded:0) once finish_shots exist, so a clean row is distinguishable from an unmeasured one.
  if (job.finish_shots) {
    const fin = summarizeFinish(job.finish_shots);
    out.finish = { degraded: fin.degraded, reasons: fin.reasons };
  }
  if (job.keyframes_only && job.keyframes?.length) {
    out.keyframes = job.keyframes.map((k) => ({ shot_id: k.shot_id, key: k.keyframe_key }));
    out.scenes = job.scenes;
  }
  if (job.derive_mode && clipJob) {
    const clips = clipJob.shots
      .filter((s) => s.status === "done" && s.clip_key)
      .map((s) => ({
        shot_id: s.shot_id,
        key: s.clip_key as string,
        model: s.motion_backend ?? clipJob.motion_backend ?? undefined,
      }));
    if (clips.length) out.clips = clips;
    const models = new Set(clips.map((c) => c.model).filter(Boolean));
    if (models.size === 1) out.model = [...models][0];
    else if (job.motion_backend) out.model = job.motion_backend;
  }
  if (job.keyframes_incomplete) out.keyframes_incomplete = job.keyframes_incomplete;
  const deliveries = clipDeliveries(clipJob);
  if (deliveries) out.clip_deliveries = deliveries;
  return out;
}

/** The `output_json` payload for a scatter job at phase `done`. BOTH scatter writers build it here:
 *  `finalizeScatterDone` (via `markFinishDone`) and `scatterJobToPollView` (via
 *  `updateRenderFromView`). They run in that order inside one tick, so the view is the last writer;
 *  identical bytes are what makes that ordering harmless rather than load-bearing. */
export function scatterDonePayload(job: ScatterJob): Record<string, unknown> {
  // cf#1662: scatter carries the identical film_finish shape and was equally invisible; ALWAYS
  // set, including null.
  return {
    output_key: job.film_key,
    project: job.project,
    mode: "full",
    film_finish: filmFinishView(job.film_finish),
  };
}
