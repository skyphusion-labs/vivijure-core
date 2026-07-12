// Pure clip-job shapes + summary (shared by film-model and render-orchestrator).

export interface ClipShotInput {
  shot_id: string;
  keyframe_url: string;
  keyframe_key?: string;
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
  distilled?: boolean;
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
