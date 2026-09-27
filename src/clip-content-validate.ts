// #523 Layer 2: pixel-content clip validation at the film finish gate.
//
// Layer 1 (src/clip-validate.ts) rejects STRUCTURAL corruption in-Worker but cannot decode pixels, so a
// structurally-valid clip of pure latent noise (local-16gb#35: CogVideoX on a vGPU) passes it. Layer 2
// closes that: it asks the video-finish CPU container (which already runs ffmpeg, and is already the
// finish/assemble dependency) to look at the actual frames, at the SAME clip-intake seam, BEFORE the
// finish / upscale GPU spend. Bytes never touch the Worker: the core presigns GET URLs and the container
// fetches them (the /finish presign pattern).
//
// Posture (warn-and-degrade default, #523's false-positive concern -- deliberately-abstract films exist):
//   - "corrupt": the container is CONFIDENT (the clip's first frame does not resemble its conditioning
//     keyframe -- the #35 signature). FAIL the shot with the real reason, before finish/upscale spend.
//   - "suspect": the weaker content-only heuristic (chromatic-noise signature) fired. WARN: record a
//     degrade marker; the film still completes. Never a hard fail on the heuristic alone.
//   - "ok" / "skip": pass. "skip" = the tier is not installed (self-host), the container was unreachable,
//     or the inspect errored -- a down inspector must never fail a real render.
//
// Runs at the film finish gate ONLY (where finish/upscale spend happens), not on the standalone clips
// route (which has no downstream spend); Layer 1 covers that route.

import type { Env } from "./platform/orchestrator-context.js";
import { isMediaFinishAuthError, mediaFinishHeaders, videoFinishFetch, videoFinishReachable } from "./media-finish-auth.js";
import type { ClipJob } from "./clip-job-model.js";
import { presignR2Get } from "./presign.js";
import { emitStructuredEvent } from "./structured-events.js";

const INSPECT_TTL_SECONDS = 1800;

/** The video-finish container's POST /inspect response (containers/video-finish/app.py + inspect_core.py). */
export interface InspectResult {
  ok: boolean;
  verdict: "ok" | "suspect" | "corrupt";
  reason?: string;
  metrics?: { sat_mean: number; gray_std_mean: number; chroma_structure_ratio: number; frames: number };
  keyframe_similarity?: number | null;
  error?: string;
}

/** Call the video-finish container's POST /inspect, retrying the transient gateway statuses (503/504) the
 *  way callVideoFinish does for /finish. backoffMs is injectable so tests do not wait.
 *
 *  Returns the parsed result, or an UNREACHABLE marker the caller can act on (core#321). The
 *  distinction is not cosmetic: contentValidateDoneClips walks shots SEQUENTIALLY, so a container
 *  that is down costs its whole retry budget once per shot.
 *
 *  A THROWN fetch (NXDOMAIN, connection refused, a container that died before binding 8000, which is
 *  cf#851's exact signature) is NOT the gateway-busy condition the backoff was written for, and one
 *  attempt establishes it. It used to retry anyway, because the loop's break tested
 *  `resp && resp.status !== 503 ...` and a throw leaves resp null, which is falsy, which is not a
 *  break. Three attempts at 1500ms, per shot, sequentially: about 3s a shot, roughly 51s of a finish
 *  pass on a 17-shot film, re-paid on later ticks because core#30 says not to persist the skip.
 *
 *  The 503/504 retry is UNCHANGED and deliberately so: that one is the container saying "busy, come
 *  back", and cutting it would trade this latency problem for a coverage problem, i.e. more false
 *  `unmeasured` records, which is the state cf#856 exists to make visible. */
export async function callVideoFinishInspect(
  env: Env,
  payload: { clipUrl: string; keyframeUrl?: string },
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<InspectResult | { unreachable: true } | null> {
  if (!videoFinishReachable(env)) return null;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const init = {
    method: "POST",
    headers: await mediaFinishHeaders(env),
    body: JSON.stringify(payload),
  };
  let last: Response | undefined;
  for (let attempt = 0; attempt < retries; attempt++) {
    let resp: Response | null;
    try {
      resp = await videoFinishFetch(env, "/inspect", init);
    } catch (e) {
      if (isMediaFinishAuthError(e)) throw e;
      // The transport itself failed. No amount of waiting makes a name resolve or a dead process
      // bind, so stop here instead of sleeping twice to ask the same question.
      return { unreachable: true };
    }
    // videoFinishFetch RESOLVES to null when the door is unset or could not be reached at all.
    // Same class as a throw, equally unhelped by waiting, and it used to sit in the retry loop too
    // because the old break condition (`resp && ...`) read null as "keep trying".
    if (!resp) return { unreachable: true };
    last = resp;
    if (resp.status !== 503 && resp.status !== 504) break;
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, backoffMs));
  }
  // Exhausted the 503/504 budget, or a non-2xx answer: the tier is up but not serving this call.
  if (!last || !last.ok) return { unreachable: true };
  try {
    return (await last.json()) as InspectResult;
  } catch {
    // It answered 2xx with a body that will not parse. That is the container misbehaving on THIS
    // clip, not the tier being down, so it is not an unreachable marker and must not trip the
    // per-pass breaker.
    return null;
  }
}

/** True when the inspect call could not reach a serving container at all (core#321). */
function isUnreachable(r: InspectResult | { unreachable: true } | null): r is { unreachable: true } {
  return r !== null && (r as { unreachable?: true }).unreachable === true;
}

export interface ContentVerdict {
  verdict: "ok" | "suspect" | "corrupt" | "skip";
  /** core#321: this skip means "the container is not serving", not "this one clip could not be
   *  inspected". The per-pass breaker trips on THIS FIELD, never on a reason string: a string match
   *  is not a relationship, and a reason is prose that someone will reword without thinking about a
   *  breaker. */
  unreachable?: true;
  reason?: string;
  metrics?: InspectResult["metrics"];
  keyframe_similarity?: number | null;
}

/** Presign the clip (and its keyframe, when known) and ask the container for a content verdict. Skips
 *  honestly (never throws, never fails a render) when the tier is unavailable. */
export async function contentValidateClip(env: Env, clipKey: string, keyframeKey?: string): Promise<ContentVerdict> {
  if (!videoFinishReachable(env)) return { verdict: "skip", reason: "video-finish tier not installed (VIDEO_FINISH_URL unset)" };
  let clipUrl: string;
  let keyframeUrl: string | undefined;
  try {
    clipUrl = await presignR2Get(env, clipKey, INSPECT_TTL_SECONDS);
    if (keyframeKey) keyframeUrl = await presignR2Get(env, keyframeKey, INSPECT_TTL_SECONDS);
  } catch (e) {
    return { verdict: "skip", reason: `presign failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = await callVideoFinishInspect(env, { clipUrl, keyframeUrl });
  if (isUnreachable(r)) {
    return { verdict: "skip", reason: "video-finish /inspect unreachable or errored", unreachable: true };
  }
  if (!r || !r.ok || !r.verdict) return { verdict: "skip", reason: "video-finish /inspect unreachable or errored" };
  return { verdict: r.verdict, reason: r.reason, metrics: r.metrics, keyframe_similarity: r.keyframe_similarity };
}

/** #523 Layer 2 pass over a clip job's done clips, at the film finish gate. For each structurally-valid
 *  (Layer 1) done clip not yet content-checked, ask the container: a "corrupt" verdict FAILS the shot with
 *  the real reason BEFORE finish/upscale spend (honest failure); a "suspect" verdict records a warn/degrade
 *  marker and lets the film complete; "ok"/"skip" pass. Idempotent per shot (content_validated). Emits one
 *  `clip.content_validate` structured event per shot. Returns true iff it changed any shot; the CALLER owns
 *  the job-doc write. A no-op (returns false immediately) when the video-finish tier is not installed. */
export async function contentValidateDoneClips(
  env: Env,
  job: ClipJob,
  inspect: (env: Env, clipKey: string, keyframeKey?: string) => Promise<ContentVerdict> = contentValidateClip,
): Promise<boolean> {
  if (!videoFinishReachable(env)) return false;
  let changed = false;
  // core#321: once ONE shot has established that the container is not serving, the remaining shots
  // in this pass do not re-probe it. They still get the cf#856 unmeasured record, because the film
  // is equally unvouched-for either way and a record that depended on probe ORDER would be a worse
  // lie than no record at all. O(shots) transport failures become O(1) per pass, and nothing is
  // latched beyond this pass: the next tick starts clean and tries again.
  let tierDown: string | undefined;
  for (const shot of job.shots) {
    // #30: "skip" (a transient /inspect outage or the tier being unavailable) is NOT a validation result, so
    // it must not short-circuit re-inspection -- only a terminal verdict (ok / suspect / corrupt) counts as
    // done. Otherwise a single-moment inspector blip at the one tick the finish phase runs disables Layer 2
    // (the pixel/noise gate) for the whole pass and the clip ships ungated.
    if (shot.status !== "done" || !shot.clip_key || (shot.content_validated && shot.content_validated !== "skip")) continue;
    const v: ContentVerdict = tierDown
      ? { verdict: "skip", reason: tierDown, unreachable: true }
      : await inspect(env, shot.clip_key, shot.keyframe_key);
    if (v.unreachable && !tierDown) tierDown = v.reason ?? "video-finish /inspect unreachable";
    // Don't persist "skip" as a verdict: leave it unset so a later tick re-inspects.
    if (v.verdict !== "skip") shot.content_validated = v.verdict;
    // cf#856: but DO say that it could not run. Measured on a live film while the container was
    // crashing: 5 skips, 0 passes, and the film advanced with nothing anywhere recording that the
    // pixel gate never looked at a single clip. A skip left only in a log line is indistinguishable
    // from a pass to every reader except one who happened to have `wrangler tail` attached.
    // SEPARATE from content_validated on purpose (see #30 above): the verdict stays unset so
    // re-inspection still happens, and this carries the reason meanwhile. Written only when it
    // CHANGES, so a down inspector does not rewrite the doc every tick, and cleared the moment a
    // terminal verdict lands, so it cannot go stale.
    const unmeasured = v.verdict === "skip" ? (v.reason ?? "content validation could not run") : undefined;
    if (shot.content_unmeasured !== unmeasured) {
      if (unmeasured) shot.content_unmeasured = unmeasured;
      else delete shot.content_unmeasured;
      changed = true;
    }
    emitStructuredEvent({
      ev: "clip.content_validate",
      job_id: job.job_id,
      shot_id: shot.shot_id,
      verdict: v.verdict,
      ...(v.keyframe_similarity != null ? { keyframe_similarity: v.keyframe_similarity } : {}),
      ...(v.metrics ? { metrics: v.metrics } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
    });
    if (v.verdict === "corrupt") {
      shot.status = "failed";
      shot.error = `clip failed content validation: ${v.reason ?? "does not resemble its keyframe"}`;
      shot.poll = undefined;
      changed = true;
    } else if (v.verdict === "suspect") {
      shot.content_degraded = v.reason ?? "chromatic-noise signature"; // warn-and-degrade: film still completes
      changed = true;
    }
  }
  return changed;
}

/** cf#856: what Layer 2 actually MEASURED on this clip job, for the render record.
 *
 *  THE LADDER, the same three states cf#836 established for the per-stage degrades, because the
 *  failure they both prevent is the same one (two states reported as one):
 *    undefined    -> Layer 2 never ran on this job at all. NOT MEASURED. (Self-host with no
 *                    VIDEO_FINISH_URL is exactly this, and it is honest: the tier is not installed.)
 *    unmeasured 0 -> it ran on every done clip and every one got a verdict.
 *    unmeasured n -> it could not measure n of them, and `reasons` says why, verbatim.
 *
 *  Counts the population Layer 2 covers: DONE shots that produced a clip. */
export function contentValidationView(
  job: ClipJob,
): { checked: number; unmeasured: number; reasons: string[] } | undefined {
  const covered = job.shots.filter((s) => s.status === "done" && s.clip_key);
  const checked = covered.filter((s) => s.content_validated && s.content_validated !== "skip").length;
  const blocked = covered.filter(
    (s) => typeof s.content_unmeasured === "string" && s.content_unmeasured.length > 0,
  );
  if (checked === 0 && blocked.length === 0) return undefined;
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const s of blocked) {
    const r = s.content_unmeasured as string;
    if (seen.has(r)) continue;
    seen.add(r);
    reasons.push(r);
  }
  return { checked, unmeasured: blocked.length, reasons };
}
