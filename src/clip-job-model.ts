// Pure clip-job shapes + summary (shared by film-model and render-orchestrator).

export interface ClipShotInput {
  shot_id: string;
  keyframe_url: string;
  keyframe_key?: string;
  last_keyframe_url?: string;
  last_keyframe_key?: string;
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
  content_validated?: "ok" | "suspect" | "corrupt" | "skip";
  content_degraded?: string;
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
  // #719: consecutive TRANSIENT poll-error count (see applyPoll). Reset on any successful poll;
  // the shot fails loud at CLIP_POLL_MAX_ATTEMPTS instead of on the first blip.
  poll_attempts?: number;
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
