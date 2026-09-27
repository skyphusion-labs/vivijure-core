// Pure clip-job shapes + summary (shared by film-model and render-orchestrator).

export interface ClipShotInput {
  shot_id: string;
  keyframe_url: string;
  keyframe_key?: string;
  last_keyframe_url?: string;
  last_keyframe_key?: string;
  voice_ref_url?: string;
  voice_ref_key?: string;
  audio_url?: string;
  audio_key?: string;
  prompt: string;
  seconds: number;
  motion_backend?: string;
}

export interface ClipShot extends ClipShotInput {
  status: "pending" | "done" | "failed";
  poll?: string;
  clip_key?: string;
  error?: string;
  binding?: string | null;
  runpod_job_id?: string;
  cancel_sent?: boolean;
  validated?: "pass" | "fail" | "skip";
  /** core#310: why Layer 1 COULD NOT RUN on this shot, when it could not.
   *
   *  The same split core#30 made for Layer 2 and cf#856 gave a word to, applied one layer down:
   *  `validated` holds a VERDICT and stays unset on a skip so the next tick re-validates, while
   *  this carries the honest reason meanwhile. Before this, a skip was written into `validated`,
   *  where it is truthy, so the idempotence guard short-circuited and a shot whose artifact was
   *  momentarily unreadable was never structurally checked again. Cleared the moment a verdict
   *  lands. */
  validated_unmeasured?: string;
  content_validated?: "ok" | "suspect" | "corrupt" | "skip";
  content_degraded?: string;
  /** cf#856: why Layer 2 COULD NOT RUN on this shot, when it could not.
   *
   *  Deliberately NOT `content_validated = "skip"`. #30 established that a skip must not be
   *  persisted as a verdict, because a truthy value there short-circuits re-inspection and one
   *  inspector blip disables the pixel gate for the whole pass. So the two facts are separate
   *  fields: `content_validated` stays UNSET so the next tick re-inspects, and this says out loud
   *  that the last attempt could not measure anything. Cleared the moment a terminal verdict lands,
   *  so it can never be stale. */
  content_unmeasured?: string;
  delivered_fps?: number;
  delivered_frames?: number;
  /** cf#507b: the clip's ACTUAL pixel dimensions, as probed from its mp4 `tkhd` box.
   *
   *  Already computed on every done clip -- validateDoneClips calls validateClipArtifact, which
   *  parses these into `checks.width/height` -- and, until now, DISCARDED one line later into a log
   *  event while only the verdict was persisted. No new probe, no container change: these are two
   *  numbers the system already measures and threw away.
   *
   *  A MEASUREMENT. Its only consumer is the upscale factor choice. The film's delivery target is
   *  FilmJob.delivery_width/height, which is a decision and a different quantity. */
  delivered_width?: number;
  delivered_height?: number;
  distilled?: boolean;
  /** Motion backend said the mp4 already has a soundtrack (native AV). */
  has_audio?: boolean;
  /** Previous takes of this shot (reroll archives, does not delete). */
  takes?: { key: string; at: number }[];
  // #719: consecutive TRANSIENT poll-error count (see applyPoll). Reset on any successful poll;
  // the shot fails loud at CLIP_POLL_MAX_ATTEMPTS instead of on the first blip.
  poll_attempts?: number;
  // Next-tick resubmits after a transient invoke fail or a provider job that died on load/429/7003.
  // Distinct from poll_attempts: re-polling a dead job token cannot recover those.
  submit_attempts?: number;
  // #767: the resolved, validated motion config for this shot, retained so the R2-presence reclaim can
  // fingerprint what produced a clip (motion_backend + config + keyframe + prompt) and refuse to adopt a
  // clip a DIFFERENT-config render of the same project+shot wrote. Absent on legacy job docs.
  config?: Record<string, unknown>;
}

export interface ClipJob {
  job_id: string;
  project: string;
  motion_backend: string | null;
  binding: string | null;
  module_configs?: Record<string, Record<string, unknown>>;
  shots: ClipShot[];
  created_at: number;
}

export interface JobSummary {
  total: number;
  done: number;
  failed: number;
  pending: number;
  complete: boolean;
}

export function summarizeJob(job: ClipJob): JobSummary {
  const total = job.shots.length;
  const done = job.shots.filter((s) => s.status === "done").length;
  const failed = job.shots.filter((s) => s.status === "failed").length;
  return { total, done, failed, pending: total - done - failed, complete: done + failed === total };
}
