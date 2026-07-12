// Bridge between the film orchestrator (module render path) and the planner's RunPod-shaped
// poll contract. POST /api/storyboard/render uses startFilmJob when keyframe (+ motion for full
// renders) modules are installed; GET /api/storyboard/render/:jobId routes film-* ids here.

import type { ClipJob } from "./render-orchestrator.js";
import type { FilmJob, FilmScene } from "./film-model.js";
import {
  summarizeFilm,
  clipDeliveries,
  KEYFRAME_STALL_SECONDS,
} from "./film-model.js";
import type { RunpodJobView, RunpodStatus } from "./runpod-types.js";
import {
  resolveModuleRenderConfigs,
  type RenderTier,
  type ResolvedModuleRenderConfigs,
} from "./render-module-config.js";
import type { RegisteredModule } from "./modules/types.js";

export { KEYFRAME_STALL_SECONDS };

export function isFilmJobId(jobId: string): boolean {
  return typeof jobId === "string" && jobId.startsWith("film-");
}

/** Host renders-table insert shape derived from a FilmJob (DB layer maps this in the host). */
export interface FilmRenderRowSeed {
  jobId: string;
  project: string;
  bundleKey: string;
  qualityTier: string;
  status: string;
  mode?: "full" | "keyframes-only" | "finalized" | "cloud-finalized";
  parentId?: number | null;
}

export function filmRenderRowSeedFromJob(job: FilmJob): FilmRenderRowSeed {
  const mode = job.derive_mode ?? (job.keyframes_only ? "keyframes-only" : "full");
  return {
    jobId: job.film_id,
    project: job.project,
    bundleKey: job.bundle_key,
    qualityTier: "final",
    status: filmJobToPollView(job, null).status,
    mode,
    parentId: job.parent_render_id ?? null,
  };
}

export function mapRenderOverridesToModuleConfigs(
  overrides: unknown,
  qualityTier: RenderTier,
  modules: RegisteredModule[],
): ResolvedModuleRenderConfigs {
  return resolveModuleRenderConfigs(overrides, qualityTier, modules);
}

export function normalizeFilmScenes(raw: unknown): FilmScene[] {
  if (!Array.isArray(raw)) return [];
  const out: FilmScene[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const shot_id = typeof o.shot_id === "string" ? o.shot_id.trim() : "";
    const prompt = typeof o.prompt === "string" ? o.prompt : "";
    const seconds = typeof o.seconds === "number" && o.seconds > 0 ? o.seconds : 4;
    if (shot_id && prompt.trim()) out.push({ shot_id, prompt, seconds });
  }
  return out;
}

export function filterScenesByShotIds(scenes: FilmScene[], shotIds: string[] | undefined): FilmScene[] {
  if (!shotIds || shotIds.length === 0) return scenes;
  const allow = new Set(shotIds);
  return scenes.filter((s) => allow.has(s.shot_id));
}

export function orderScenesByShotIds(scenes: FilmScene[], shotIds: string[]): FilmScene[] {
  const byId = new Map(scenes.map((s) => [s.shot_id, s]));
  const out: FilmScene[] = [];
  for (const id of shotIds) {
    const s = byId.get(id);
    if (s) out.push(s);
  }
  return out;
}

export function stallSignal(job: FilmJob, now: number = Date.now()): Record<string, unknown> {
  const lastProgressAt = job.last_progress_at ?? job.phase_started_at ?? job.created_at;
  const ageSeconds = Math.max(0, Math.floor((now - lastProgressAt) / 1000));
  const stalled = ageSeconds >= KEYFRAME_STALL_SECONDS;
  const out: Record<string, unknown> = { last_progress_at: lastProgressAt };
  if (stalled) {
    out.stalled = true;
    out.stall_seconds = ageSeconds;
  }
  return out;
}

function phaseProgress(job: FilmJob, clipJob: ClipJob | null, keyframeDone?: number): Record<string, unknown> {
  const total = job.scenes.length;
  const summary = summarizeFilm(job, clipJob);
  const base = { scene_total: total, project: job.project, ...stallSignal(job) };

  switch (job.phase) {
    case "keyframe": {
      if (typeof keyframeDone === "number" && total > 0) {
        return {
          ...base,
          phase: "keyframe",
          scene_index: Math.min(total, keyframeDone + 1),
          progress: Math.min(1, keyframeDone / total),
        };
      }
      return { ...base, phase: "keyframe", scene_index: 1 };
    }
    case "clips": {
      const c = summary.clips;
      const done = c?.done ?? 0;
      const progress = c && c.total > 0 ? done / c.total : undefined;
      return {
        ...base,
        phase: "i2v",
        scene_index: Math.min(total, done + 1),
        progress,
      };
    }
    case "finish": {
      const f = summary.finish;
      const done = f?.done ?? 0;
      return { ...base, phase: "finish", scene_index: Math.min(total, done + 1) };
    }
    case "assemble":
      return { ...base, phase: "assemble" };
    case "mux":
      return { ...base, phase: "mux" };
    default:
      return base;
  }
}

export function filmJobToPollView(job: FilmJob, clipJob: ClipJob | null, keyframeDone?: number): RunpodJobView {
  let status: RunpodStatus;
  let output: Record<string, unknown> | undefined;

  if (job.cancelled) {
    status = "CANCELLED";
  } else if (job.phase === "done") {
    status = "COMPLETED";
    const mode = job.derive_mode ?? (job.keyframes_only ? "keyframes-only" : "full");
    output = {
      output_key: job.film_key,
      project: job.project,
      mode,
    };
    if (job.film_finish?.sidecar_key) output.sidecar_key = job.film_finish.sidecar_key;
    if (job.finish_unavailable) {
      output.finish_unavailable = {
        at: job.finish_unavailable.at,
        reason: job.finish_unavailable.reason,
        delivered: job.finish_unavailable.delivered,
      };
      const uClips = job.finish_unavailable.clips;
      if (uClips?.length) output.clips = uClips.map((c) => ({ shot_id: c.shot_id, key: c.clip_key }));
    }
    if (job.keyframes_only && job.keyframes?.length) {
      output.keyframes = job.keyframes.map((k) => ({ shot_id: k.shot_id, key: k.keyframe_key }));
      output.scenes = job.scenes;
    }
    if (job.derive_mode && clipJob) {
      const clips = clipJob.shots
        .filter((s) => s.status === "done" && s.clip_key)
        .map((s) => ({
          shot_id: s.shot_id,
          key: s.clip_key as string,
          model: s.motion_backend ?? clipJob.motion_backend ?? undefined,
        }));
      if (clips.length) output.clips = clips;
      const models = new Set(clips.map((c) => c.model).filter(Boolean));
      if (models.size === 1) output.model = [...models][0];
      else if (job.motion_backend) output.model = job.motion_backend;
    }
  } else if (job.phase === "failed") {
    status = "FAILED";
  } else {
    status = "IN_PROGRESS";
    output = phaseProgress(job, clipJob, keyframeDone);
  }

  if (job.keyframes_incomplete && output) output.keyframes_incomplete = job.keyframes_incomplete;

  const deliveries = clipDeliveries(clipJob);
  if (deliveries && output) output.clip_deliveries = deliveries;

  return {
    jobId: job.film_id,
    status,
    statusRaw: job.cancelled ? "CANCELLED" : job.phase,
    output,
    error: job.error,
    executionTimeMs: Math.max(0, Date.now() - job.created_at),
  };
}
