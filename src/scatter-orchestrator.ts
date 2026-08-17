// Scatter/gather render orchestrator: N parallel film jobs (clips_only shards) + one gather assemble.

import type { Env, ExecutionContext } from "./platform/orchestrator-context.js";
import { videoFinishReachable } from "./media-finish-auth.js";
import { encodeAssemblePoll, tickVideoFinishAssemble } from "./video-finish-assemble.js";
import type { ScatterJob } from "./scatter-orchestrator-types.js";
import {
  advanceFilmJob,
  cancelFilmJob,
  clipKeysFromFilmJob,
  filmJobDocKey,
  filmPhaseToShardStatus,
  orderFinalClips,
  startFilmJob,
  runFilmFinish,
  resolveClipDurationFloor,
  mapClipDurationsToShots,
  resolvePlannedSeconds,
  findClipDurationShortfalls,
  outputMsFromSeconds,
  accumulateFinishElapsed,
  type FilmJob,
  type FilmScene,
} from "./film-orchestrator.js";
import { applyVoiceSeed, voiceLockFromCast } from "./film-model.js";
import { generateAudioOn, motionScatterAllowed, usageOf } from "./motion-usage.js";
import { readShotDurationsFromBundle } from "./bundle-durations.js";
import { filmJobToPollView, filterScenesByShotIds, orderScenesByShotIds, mapRenderOverridesToModuleConfigs } from "./film-render-bridge.js";
import { scatterDonePayload } from "./render-output-payload.js";
import { presignR2Get, presignR2Put } from "./presign.js";
import { resolveStagedAudioKey } from "./audio-stage.js";
import { defaultGpuDoorModule, discoverModules, servingForHook } from "./modules/registry.js";
import { readBundleScenes } from "./bundle-storyboard.js";
import type { ParsedBundleScene } from "./planner-yaml.js";
import { getProjectById } from "./storyboard-projects-db.js";
import { buildDialogueLines, dialogueLinesFromBundleScenes } from "./dialogue-lines.js";
import type { DialogueLine } from "./modules/types.js";
import {
  gatherDecision,
  isScatterParentJobId,
  scatterParentJobId,
  scatterShards,
  type ShardStatus,
} from "./scatter.js";
import type { RunpodJobView, RunpodStatus } from "./runpod-submit.js";
import {
  claimFinish,
  getFinishState,
  getRenderIdByJobId,
  getScatterChildren,
  insertRender,
  buildInsertRenderStmt,
  markFinishDone,
  markFinishFailed,
  markRenderFailedByJobId,
  updateRenderFromView,
  prepareRenderUpdate,
  runPreparedRenderUpdates,
  runPreparedWrites,
} from "./renders-db.js";
import type { PreparedRenderUpdate } from "./renders-db.js";
import { resolveCastLoras, untrainedCastMessage } from "./cast-loras.js";
import { fireNotifyForScatter } from "./scatter-notify.js";
import { isTransientD1Error, withD1Retry, d1ErrorCode } from "./d1-retry.js";

export type { ScatterJob } from "./scatter-orchestrator-types.js";
export { isScatterParentJobId as isScatterJobId };

const scatterDocKey = (id: string) => `renders/${id}/scatter-job.json`;
const scatterOutKey = (id: string) => `renders/${id}/film.mp4`;

async function loadScatterJob(env: Env, scatterId: string): Promise<ScatterJob | null> {
  const obj = await env.R2_RENDERS.get(scatterDocKey(scatterId));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as ScatterJob;
}

async function saveScatterJob(env: Env, job: ScatterJob): Promise<void> {
  await env.R2_RENDERS.put(scatterDocKey(job.scatter_id), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function loadFilmJobDoc(env: Env, filmId: string): Promise<FilmJob | null> {
  const obj = await env.R2_RENDERS.get(filmJobDocKey(filmId));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as FilmJob;
}

export interface StartScatterArgs {
  project: string;
  bundle_key: string;
  quality_tier: "draft" | "standard" | "final";
  shot_ids: string[];
  shard_count: number;
  cast_loras: Record<string, unknown>;
  render_overrides?: Record<string, unknown>;
  motion_backend?: string;
  audio_key?: string;
  film_titles?: { title?: { text: string; subtitle?: string }; credits?: { lines: string[] } };
  project_id?: number | null;
  /** Planner scenes. Used when the bundle tar has no parseable storyboard.yaml. */
  scenes?: FilmScene[];
  style_prefix?: string;
  voice_lock?: string;
}

/** Resolve per-shot dialogue for scatter (vivijure-core#122).
 *
 *  Order: D1 last_storyboard when project_id is present (fresher than the bundle
 *  snapshot). If that yields no lines -- no project_id, no storyboard, or empty
 *  dialogue -- fall back to dialogue carried in the bundle's storyboard.yaml via
 *  dialogueLinesFromBundleScenes (same helper as /api/render/film bundle-only voicing).
 *
 *  Bundle scenes must already be loaded by the caller (readBundleScenes); we do not
 *  re-fetch. Filter to shotIds so a shard only keeps its own lines.
 */
export async function resolveDialogueLines(
  env: Env,
  args: StartScatterArgs,
  voices: Record<string, string>,
  shotIds: string[],
  bundleScenes: ParsedBundleScene[],
): Promise<DialogueLine[]> {
  if (args.project_id != null) {
    const project = await getProjectById(env, args.project_id);
    if (project?.last_storyboard) {
      const fromD1 = buildDialogueLines(project.last_storyboard, voices, shotIds);
      if (fromD1.length > 0) return fromD1;
    }
  }
  const fromBundle = dialogueLinesFromBundleScenes(bundleScenes, voices);
  if (shotIds.length === 0) return fromBundle;
  const want = new Set(shotIds);
  return fromBundle.filter((l) => want.has(l.shot_id));
}

export async function startScatterRender(env: Env, args: StartScatterArgs): Promise<ScatterJob> {
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  if (servingForHook(modules, "keyframe").length === 0) {
    throw new Error("no keyframe module installed (bind MODULE_KEYFRAME)");
  }
  if (servingForHook(modules, "motion.backend").length === 0) {
    throw new Error("no motion.backend module installed");
  }

  const { pretrained, voices, speakerNames, castIds, skipped, skippedDetail } = await resolveCastLoras(env, args.cast_loras);
  // #739: castLoras is OPTIONAL on scatter. Absent/empty -> shards render generic, exactly like the
  // film/render siblings. The old "castLoras required for scatter" was unintended coupling baked in at
  // the v0.2.0 bulk ship (no rationale anywhere, and nothing downstream needs a non-empty cast). A
  // PRESENT-but-not-ready binding is STILL rejected (the #738-symmetric untrained-cast message), so the
  // relax never reopens the silent-drop class -- the hScatter door turns this into a 400 before any spend.
  if (skipped.length) {
    throw new Error(untrainedCastMessage(skippedDetail));
  }

  const parsed = await readBundleScenes(env, args.bundle_key);
  const fromBundle: FilmScene[] = parsed.map((s) => ({
    shot_id: s.shot_id,
    prompt: s.prompt,
    seconds: s.seconds,
  }));
  const fromRequest = (args.scenes || [])
    .filter((s) => s && typeof s.shot_id === "string" && s.shot_id && typeof s.prompt === "string")
    .map((s) => ({
      shot_id: s.shot_id,
      prompt: s.prompt,
      seconds: typeof s.seconds === "number" && s.seconds > 0 ? s.seconds : 4,
    }));
  const scenes: FilmScene[] = fromBundle.length ? fromBundle : fromRequest;
  if (!scenes.length) {
    throw new Error("scatter: bundle has no storyboard scenes (re-bundle after planning)");
  }
  const expected = args.shot_ids.filter((s) => typeof s === "string" && s.length > 0);
  if (expected.length < 2) throw new Error("scatter requires >= 2 shots");

  // Talking characters: D1 last_storyboard when present (fresher), else bundle dialogue
  // (core#122). Voices from resolveCastLoras. Empty both ways -> silent film.
  const dialogueLines = await resolveDialogueLines(env, args, voices, expected, parsed);

  const shards = scatterShards({
    shotIds: expected,
    shardCount: args.shard_count,
    pretrainedLoras: pretrained,
  });
  if (shards.length < 2) throw new Error("scatter requires >= 2 shards");

  const mapped = mapRenderOverridesToModuleConfigs(args.render_overrides, args.quality_tier, modules);
  const voiceLock = voiceLockFromCast(speakerNames, voices, args.voice_lock);
  mapped.motion_config = applyVoiceSeed(mapped.motion_config, voiceLock) ?? mapped.motion_config;
  const motionBackend = args.motion_backend ?? mapped.motion_backend ?? defaultGpuDoorModule(modules)?.name;
  if (!motionBackend) throw new Error('no gpu-door motion.backend module (ui.locality "byo"/"local") is installed');
  const motionMod = modules.find((m) => m.name === motionBackend);
  const talking = generateAudioOn(mapped.motion_config);
  if (!motionScatterAllowed(usageOf(motionMod), talking, motionBackend)) {
    throw new Error(
      motionBackend + " stays on one film so voice and look can stay consistent (no scatter)",
    );
  }
  const scatterId = scatterParentJobId(crypto.randomUUID());
  const stagedAudio = await resolveStagedAudioKey(env, args.audio_key);

  const scatterJob: ScatterJob = {
    scatter_id: scatterId,
    project: args.project,
    bundle_key: args.bundle_key,
    quality_tier: args.quality_tier,
    expected_shot_ids: expected,
    shard_film_ids: [],
    shard_shots: shards.map((s) => s.shots),
    motion_backend: motionBackend,
    audio_key: stagedAudio,
    has_dialogue: dialogueLines.length > 0,
    scenes,
    dialogue_lines: dialogueLines,
    film_titles: args.film_titles,
    film_finish_config: mapped.film_finish_config,
    project_id: args.project_id ?? null,
    render_overrides: args.render_overrides,
    phase: "shards",
    created_at: Date.now(),
  };

  // RUNNABILITY-FIRST (#289): build the shard FILM jobs (their docs live in R2), collecting the
  // render-row specs to persist to D1 afterwards. The D1 rows are a UI-list PROJECTION, not what
  // makes the render runnable -- so we never write them before the runnable R2 state.
  const shardRows: { jobId: string; status: string }[] = [];
  for (const shard of shards) {
    const shardScenes = filterScenesByShotIds(scenes, shard.shots);
    if (!shardScenes.length) {
      throw new Error(
        "scatter: none of [" + shard.shots.join(", ") + "] are in the storyboard",
      );
    }
    // Each shard runs its own finish chain (incl. lip-sync), so it carries only its shots' dialogue.
    const shardShotSet = new Set(shard.shots);
    const shardDialogue = dialogueLines.filter((l) => shardShotSet.has(l.shot_id));
    const film = await startFilmJob(env, {
      project: args.project,
      bundle_key: args.bundle_key,
      scenes: shardScenes,
      motion_backend: motionBackend,
      keyframe_backend: mapped.keyframe_backend,
      keyframe_config: mapped.keyframe_config,
      motion_config: mapped.motion_config,
      finish_config: mapped.finish_config,
      // cf#537: every shard runs its OWN finish chain, so the participation selection has to reach
      // each one. Scatter resolves and mints entirely inside core, so this is the site -- omit it and
      // a scattered render silently reverts to the default-participation set for every shard while
      // the single-film path honours the caller, which is the two-panel parity split in miniature.
      finish_select: mapped.finish_select,
      speech_config: mapped.speech_config,
      master_config: mapped.master_config,
      clips_only: true,
      pretrained_loras: shard.pretrainedLoras,
      cast_loras: castIds,
      dialogue_lines: shardDialogue,
      style_prefix: args.style_prefix,
      voice_lock: voiceLock || args.voice_lock,
    });
    scatterJob.shard_film_ids.push(film.film_id);
    shardRows.push({ jobId: film.film_id, status: filmJobToPollView(film, null).status });
  }

  await finalizeScatterSubmit(env, scatterJob, shardRows);
  return scatterJob;
}

/** Persist a scatter submit so it can NEVER orphan a render (#289).
 *
 *  (core#181: the gather tick batches its per-shard row UPDATEs the same way, via
 *  runPreparedRenderUpdates. The two paths no longer disagree about how N row writes are issued.)
 *
 *  The runnable R2 doc is written FIRST: the poll/advance path runs entirely off it
 *  (loadScatterJob), so once it lands the render is runnable and a later transient cannot strand
 *  it. The D1 render rows are a UI-list projection, written AFTER, best-effort: the parent (so the
 *  shards can FK it), then the shard rows through runPreparedWrites: one all-or-nothing batch on a
 *  host that offers `Database.batch`, one round trip per statement on a host that does not, both
 *  wrapped in withD1Retry. That guard is not decoration (core#215). `batch` is OPTIONAL in the
 *  platform contract, so the `env.DB.batch!(stmts)` this used to call threw a TypeError on a
 *  batch-less host -- and the catch below swallowed it as a d1.error, so the submit reported
 *  success having written NONE of its shard rows, leaving every one of them to the poll-path
 *  self-heal. A persistent D1 failure is logged as a structured d1.error and SWALLOWED -- the
 *  submit still succeeds (render is runnable) and the missing rows self-heal on the first poll
 *  (ensureScatterRenderRow). This is the cure for the orphan-row 422: a mid-submit blip can no
 *  longer leave a row with no job, nor fail the whole submit. The submit spans two stores (D1 rows
 *  + R2 docs), so a single DB.batch cannot make it truly atomic; runnability-first ordering plus
 *  self-heal makes the residual gap benign. */
export async function finalizeScatterSubmit(
  env: Env,
  scatterJob: ScatterJob,
  shardRows: { jobId: string; status: string }[],
): Promise<void> {
  await saveScatterJob(env, scatterJob); // <- render is RUNNABLE from here

  try {
    await withD1Retry(
      () =>
        insertRender(env, {
          jobId: scatterJob.scatter_id,
          project: scatterJob.project,
          bundleKey: scatterJob.bundle_key,
          qualityTier: scatterJob.quality_tier,
          renderOverrides: scatterJob.render_overrides,
          status: "IN_QUEUE",
          mode: "full",
          projectId: scatterJob.project_id ?? null,
          // cf#393: scatter parent + shards share the resolved motion backend.
          motionBackend: scatterJob.motion_backend ?? null,
        }),
      { label: "scatter.submit.parent" },
    );
    const parentId = await getRenderIdByJobId(env, scatterJob.scatter_id);
    if (shardRows.length) {
      const stmts = shardRows.map((r) =>
        buildInsertRenderStmt(env, {
          jobId: r.jobId,
          project: scatterJob.project,
          bundleKey: scatterJob.bundle_key,
          qualityTier: scatterJob.quality_tier,
          renderOverrides: scatterJob.render_overrides,
          status: r.status,
          mode: "full",
          projectId: scatterJob.project_id ?? null,
          parentId: parentId ?? undefined,
          motionBackend: scatterJob.motion_backend ?? null,
        }),
      );
      await runPreparedWrites(env, stmts, "scatter.submit.shards");
    }
  } catch (e) {
    // Render is already runnable off the R2 doc; the rows self-heal on first poll. Log, don't throw.
    console.log(JSON.stringify({
      ev: "d1.error", op: "scatter.submit.rows", scatter_id: scatterJob.scatter_id, code: d1ErrorCode(e),
    }));
  }
}

async function muxScatterAudio(env: Env, job: ScatterJob): Promise<void> {
  const silentKey = job.silent_film_key;
  const audioKey = job.audio_key;
  if (!silentKey || !audioKey) {
    job.film_key = silentKey;
    job.phase = "done";
    return;
  }
  if (!videoFinishReachable(env)) {
    job.phase = "failed";
    job.error = "video-finish URL not configured";
    return;
  }
  const outKey = job.mux_output_key ?? scatterOutKey(job.scatter_id);
  job.mux_output_key = outKey;
  let payload = {
    clips: [] as { url: string }[],
    outputUrl: "https://invalid.invalid/mux",
    outputKey: outKey,
    audioUrl: undefined as string | undefined,
    remuxAudioOnly: true,
  };
  if (!job.assemble_poll) {
    payload = {
      ...payload,
      clips: [{ url: await presignR2Get(env, silentKey, 1800) }],
      outputUrl: await presignR2Put(env, outKey, 1800),
      audioUrl: await presignR2Get(env, audioKey, 1800),
    };
  }
  const tick = await tickVideoFinishAssemble(env, payload, job.assemble_poll);
  if (tick.kind === "pending") {
    job.assemble_poll = encodeAssemblePoll(tick.poll);
    job.phase = "mux";
    job.error = undefined;
    return;
  }
  job.assemble_poll = undefined;
  if (tick.kind === "failed") {
    job.phase = "failed";
    job.error = tick.error;
    return;
  }
  const body = tick.result;
  if (!body.ok) {
    job.phase = "failed";
    job.error = `scatter mux failed: ${body.error || "unknown"}`;
    return;
  }
  if (typeof body.durationSeconds === "number" && body.durationSeconds > 0) {
    job.film_output_seconds ??= {};
    job.film_output_seconds[outKey] = body.durationSeconds;
  }
  accumulateFinishElapsed(job, body.elapsedMs);
  job.film_key = outKey;
  job.phase = "done";
}

async function maybeFinalizeScatter(env: Env, job: ScatterJob): Promise<void> {
  // Re-entrant from either the terminal "done" transition or the non-terminal "finishing" resume
  // phase (#23): an async film.finish step still encoding must NOT let the render finalize.
  if ((job.phase !== "done" && job.phase !== "finishing") || !job.film_key) return;
  const st = await getFinishState(env, job.scatter_id);
  if (st?.finish_state === "done") return;
  const complete = await runScatterFilmFinish(env, job);
  if (!complete) {
    // #23: film.finish is in flight (a card step returned a poll token). Park in the non-terminal
    // "finishing" phase and DO NOT finalize -- the next gather tick re-drives runScatterFilmFinish,
    // resuming its persisted polls (#600/#602/#663), and only finalizes once the chain completes.
    // The single-film path does the equivalent by leaving transitionToDone's phase non-terminal.
    job.phase = "finishing";
    await saveScatterJob(env, job);
    return;
  }
  job.phase = "done";
  await finalizeScatterDone(env, job);
}

/** Run the film.finish chain (subtitle / title / credit cards) on the assembled+muxed scatter film,
 *  mirroring the single-film path's inline film.finish (#284/#285). The assembled clip order ==
 *  expected_shot_ids order (orderFinalClips), so the FULL scenes + dialogue_lines give correctly aligned
 *  cumulative captions. FAIL-SAFE + idempotent: guarded by job.film_finish so a re-driven finalize never
 *  double-runs, and runFilmFinish soft-degrades (a card miss never drops the assembled film). */
async function runScatterFilmFinish(env: Env, job: ScatterJob): Promise<boolean> {
  if (job.film_finish || !job.film_key) return true; // already run (or nothing to card) -> complete
  job.film_finish_dispatched ??= {};
  job.film_finish_polls ??= {};
  job.film_finish_attempts ??= {};
  job.film_finish_prepend ??= {};
  job.film_output_seconds ??= {};
  const r = await runFilmFinish(env, {
    // cf#507b: scatter films decide their delivery target like every other path. Without this they
    // silently take the default while the film path decides, which is how a permanent inconsistency
    // gets in under "not a regression". ScatterJob has no delivery_* fields today, so this resolves
    // to the estate default -- but it resolves it through the SAME single source, so giving scatter
    // a per-film target later is a populate-it change rather than another call site to remember.
    delivery_width: (job as { delivery_width?: number }).delivery_width,
    delivery_height: (job as { delivery_height?: number }).delivery_height,
    delivery_fps: (job as { delivery_fps?: number }).delivery_fps,
    film_key: job.film_key,
    // Caption scenes in the SAME order the gather assembles the clips (expected_shot_ids), NOT bundle
    // order, so buildCaptionCues' cumulative timeline matches the cut (the crux, #284/#285).
    scenes: orderScenesByShotIds(job.scenes ?? [], job.expected_shot_ids),
    dialogue_lines: job.dialogue_lines,
    film_titles: job.film_titles,
    film_finish_config: job.film_finish_config,
    bundle_key: job.bundle_key,
    project: job.project,
    job_id: job.scatter_id,
    actual_durations: job.actual_clip_durations,
  }, undefined, {
    // #600 in-flight guard: persist a dispatch BEFORE it fires so a killed tick cannot re-dispatch a
    // duplicate encode of the same step.
    dispatched: job.film_finish_dispatched,
    persistDispatch: async (key, ts) => { job.film_finish_dispatched![key] = ts; await saveScatterJob(env, job); },
    // #602 async job+poll: persist the per-step module poll token + terminal-failure count so a long
    // single film.finish step survives across gather ticks instead of re-burning each tick.
    polls: job.film_finish_polls,
    attempts: job.film_finish_attempts,
    persistPoll: async (key, token) => {
      if (token === null) delete job.film_finish_polls![key];
      else job.film_finish_polls![key] = token;
      await saveScatterJob(env, job);
    },
    // #663: persist title-card prepend offsets across gather ticks so the post-chain .srt re-time recovers
    // them even when the prepending step is adopted (not re-folded) on a later tick.
    prepends: job.film_finish_prepend,
    persistPrepend: async (key, seconds) => { job.film_finish_prepend![key] = seconds; await saveScatterJob(env, job); },
    // Persisted per FILM ARTIFACT KEY across gather ticks, for the same adoption reason as prepends.
    durations: job.film_output_seconds,
    persistDuration: async (key, seconds) => { job.film_output_seconds![key] = seconds; await saveScatterJob(env, job); },
    // cf#268: sum module-forwarded container elapsed onto the scatter job for finalize.
    persistElapsed: async (ms) => { accumulateFinishElapsed(job, ms); await saveScatterJob(env, job); },
  });
  if (!r.ran) { job.film_finish = { applied: [], errors: [] }; return true; } // no film.finish module -> mark + skip -> complete
  if (r.errors.length > 0) console.warn(`scatter film.finish errors for ${job.scatter_id}: ${r.errors.join("; ")}`);
  if (r.degraded) console.warn(`scatter film.finish degraded for ${job.scatter_id}: ${r.degraded} -- film shipped WITHOUT cards`);
  if (!r.complete) { await saveScatterJob(env, job); return false; } // #600 in-flight: leave film_finish UNSET so the next gather tick resumes; dispatched map already persisted. NOT complete -> caller parks in "finishing" and skips finalize (#23)
  job.film_finish = { applied: r.applied, adopted: r.adopted, errors: r.errors, steps: r.steps, degraded: r.degraded, sidecar_key: r.sidecar_key };
  job.film_key = r.film_key;
  await saveScatterJob(env, job); // persist carded key + outcome before finalize records it
  return true;
}

async function assembleScatterClips(
  env: Env,
  job: ScatterJob,
  clips: { shot_id: string; clip_key: string }[],
): Promise<void> {
  if (!videoFinishReachable(env)) {
    job.phase = "failed";
    job.error = "video-finish URL not configured";
    return;
  }
  const outputKey = scatterOutKey(job.scatter_id);
  let payload = {
    clips: [] as { url: string }[],
    outputUrl: "https://invalid.invalid/gather",
    outputKey,
    keepClipAudio: true,
  };
  if (!job.assemble_poll) {
    const presigned: { url: string }[] = [];
    for (const c of clips) {
      presigned.push({ url: await presignR2Get(env, c.clip_key, 1800) });
    }
    payload = {
      ...payload,
      clips: presigned,
      outputUrl: await presignR2Put(env, outputKey, 1800),
    };
  }
  const tick = await tickVideoFinishAssemble(env, payload, job.assemble_poll);
  if (tick.kind === "pending") {
    job.assemble_poll = encodeAssemblePoll(tick.poll);
    job.phase = "gather";
    job.error = undefined;
    return;
  }
  job.assemble_poll = undefined;
  if (tick.kind === "failed") {
    job.phase = "failed";
    job.error = tick.error;
    return;
  }
  const body = tick.result;
  if (!body.ok) {
    job.phase = "failed";
    job.error = `video-finish gather failed: ${body.error || "unknown"}`;
    return;
  }
  accumulateFinishElapsed(job, body.elapsedMs);
  // #697/#698: capture the ACTUAL per-clip assembled seconds (submit order == gather clips order) and
  // gate each shot against its plan, the same per-shot honesty gate as the single-film assemble. The
  // film-level ratio check below still catches a gross whole-film drop; this catches ONE truncated shot
  // the total would mask. Persisted so the gather film.finish chain times captions to the real cut (#698).
  const actual = mapClipDurationsToShots(clips, body.clipDurations);
  job.actual_clip_durations = Object.keys(actual).length > 0 ? actual : undefined;
  if (Object.keys(actual).length > 0) {
    const bundleDurations = await readShotDurationsFromBundle(env, job.bundle_key);
    const planned = resolvePlannedSeconds(job.scenes ?? [], bundleDurations);
    const fraction = resolveClipDurationFloor(
      typeof env.FILM_CLIP_DURATION_FLOOR === "string" ? env.FILM_CLIP_DURATION_FLOOR : undefined,
    );
    const shortfalls = findClipDurationShortfalls(clips, actual, planned, fraction);
    if (shortfalls.length > 0) {
      job.phase = "failed";
      job.error = `duration gate: ${shortfalls.length} shot(s) delivered below ${Math.round(fraction * 100)}% of plan: ` +
        shortfalls.map((sf) => `${sf.shot_id} ${sf.actual.toFixed(2)}s vs planned ${sf.planned.toFixed(2)}s (floor ${sf.floor.toFixed(2)}s)`).join("; ");
      console.warn(`scatter ${job.scatter_id}: ${job.error}`);
      return;
    }
  }
  // Fail loud: a scatter render must NEVER silently complete a PARTIAL film. If the assembled film
  // is materially shorter than the sum of the cut shots' durations, clips were dropped in the
  // assemble (a fetch miss or a concat truncation) -- error instead of shipping a 1-of-N film. This
  // closes the gap that let a 3-shot render COMPLETE with one shot; per-shot clips stay intact in R2
  // for a re-driven assemble. The 0.5 ratio catches a gross partial (v4 shipped 36%) while tolerating
  // legitimate per-clip tail/beat-trim (music films) without false alarms; the container-side guard
  // (output vs its actual normalized inputs) is the precise, false-positive-free backstop.
  const expectedSeconds = (job.scenes ?? [])
    .filter((s) => job.expected_shot_ids.includes(s.shot_id))
    .reduce((sum, s) => sum + (Number.isFinite(s.seconds) && s.seconds > 0 ? s.seconds : 0), 0);
  const assembledSeconds = typeof body.durationSeconds === "number" ? body.durationSeconds : 0;
  // [#287] instrumentation: clips we SENT vs the container received vs concatenated duration --
  // definitively locates a 3 -> 1 drop (worker-sent-fewer vs container-side) on the next run.
  console.log(JSON.stringify({
    ev: "scatter.assemble.result", scatter_id: job.scatter_id, sent: clips.length,
    clipsReceived: body.clipsReceived, shots: body.shots, durationSeconds: body.durationSeconds,
    expectedSeconds,
  }));
  if (expectedSeconds > 0 && assembledSeconds > 0 && assembledSeconds < expectedSeconds * 0.5) {
    job.phase = "failed";
    job.error = `assemble dropped clips: ${assembledSeconds.toFixed(1)}s assembled vs ~${expectedSeconds.toFixed(1)}s expected across ${job.expected_shot_ids.length} shots`;
    return;
  }
  // Record the assembled artifact`s measured length against ITS key (see the film path). `assembledSeconds`
  // is the same number the partial-film guard above just used -- it was already being computed and thrown away.
  if (assembledSeconds > 0) {
    job.film_output_seconds ??= {};
    job.film_output_seconds[outputKey] = assembledSeconds;
  }
  job.silent_film_key = outputKey;
  if (job.audio_key) {
    job.phase = "mux";
    await muxScatterAudio(env, job);
  } else {
    job.film_key = outputKey;
    job.phase = "done";
  }
}

async function finalizeScatterDone(env: Env, job: ScatterJob): Promise<void> {
  if (!job.film_key) return;
  // core#205: DERIVED, shared with scatterJobToPollView. This write runs FIRST in the scatter tick
  // and updateRenderFromView(scatterJobToPollView(job)) runs after it, so the VIEW is the last writer
  // here -- the opposite order from the single-film path. Identical bytes is what makes that safe.
  await markFinishDone(
    env,
    job.scatter_id,
    job.film_key,
    JSON.stringify(scatterDonePayload(job)),
    outputMsFromSeconds(job.film_output_seconds?.[job.film_key]),
    job.finish_elapsed_ms,
  );
  await fireNotifyForScatter(env, job);
}

async function advanceScatterGather(env: Env, job: ScatterJob): Promise<void> {
  const st = await getFinishState(env, job.scatter_id);
  const claimed = await claimFinish(env, job.scatter_id);
  if (!claimed && st?.finish_state !== "finishing") return;

  const clipMap = new Map<string, string>();
  for (const filmId of job.shard_film_ids) {
    const fj = await loadFilmJobDoc(env, filmId);
    if (!fj || fj.phase !== "done") continue;
    for (const [shotId, key] of (await clipKeysFromFilmJob(env, fj)).entries()) {
      clipMap.set(shotId, key);
    }
  }
  const clips = orderFinalClips(
    job.expected_shot_ids.map((shot_id) => ({ shot_id, prompt: "", seconds: 4 })),
    [...clipMap.entries()].map(([shot_id, clip_key]) => ({ shot_id, clip_key })),
  );
  // [#287] instrumentation: pin where 3 -> 1 happens. Logs shots_expected vs clips_gathered (and
  // the resolved shot ids) at the assemble decision; the container result is logged below.
  console.log(JSON.stringify({
    ev: "scatter.gather.assemble", scatter_id: job.scatter_id,
    shots_expected: job.expected_shot_ids.length, clips_gathered: clips.length,
    shot_ids: clips.map((c) => c.shot_id),
  }));
  if (clips.length !== job.expected_shot_ids.length) {
    const err = "gather: missing clips after finish decision";
    await markFinishFailed(env, job.scatter_id, err);
    job.phase = "failed";
    job.error = err;
    return;
  }

  await assembleScatterClips(env, job, clips);
  if (job.phase === "failed") {
    await markFinishFailed(env, job.scatter_id, job.error || "scatter gather failed");
  } else {
    await maybeFinalizeScatter(env, job);
  }
}

/** A shard's per-tick advance outcome. `ok` carries the loaded film job (use its phase); otherwise
 *  `doc_missing` = the film-job doc is gone from R2 (genuinely dead), `errored` = the advance threw
 *  (a transient blip or any mid-advance error -- UNDETERMINED this tick, NOT dead). */
export type ShardAdvanceOutcome =
  | { ok: true; job: FilmJob }
  | { ok: false; reason: "doc_missing" | "errored" };

/** Map a shard's advance outcome to its gather status. The key distinction (watchdog defense-in-
 *  depth): an `errored` shard is UNDETERMINED -> IN_PROGRESS (recoverable; the gather keeps waiting
 *  and retries), NOT a SHARD_DEAD status -- so a transient-D1-blocked shard is never declared
 *  "owning shard dead". Only a genuinely-failed phase or a vanished doc maps to FAILED. */
export function shardStatusForOutcome(outcome: ShardAdvanceOutcome): string {
  if (outcome.ok) return filmPhaseToShardStatus(outcome.job);
  return outcome.reason === "doc_missing" ? "FAILED" : "IN_PROGRESS";
}

/** Self-heal the D1 render row from the runnable R2 doc (#289). Cheap read first -- a no-op once
 *  the row exists (the normal path). Only when the row is MISSING (a submit whose best-effort D1
 *  write lost the flaky window) does it insert the row at the doc's current status and, when
 *  terminal, fill status/output via updateRenderFromView. Never aborts the advance: a transient is
 *  left for the next poll; a non-transient is logged. */
export async function ensureScatterRenderRow(
  env: Env,
  job: ScatterJob,
  ctx?: ExecutionContext,
): Promise<void> {
  try {
    const view = scatterJobToPollView(job);
    let parentId = await getRenderIdByJobId(env, job.scatter_id);
    if (parentId == null) {
      await insertRender(env, {
        jobId: job.scatter_id,
        project: job.project,
        bundleKey: job.bundle_key,
        qualityTier: job.quality_tier,
        renderOverrides: job.render_overrides,
        status: view.status,
        mode: "full",
        projectId: job.project_id ?? null,
        motionBackend: job.motion_backend ?? null,
      });
      if (view.status !== "IN_PROGRESS") await updateRenderFromView(env, view, ctx);
      console.log(JSON.stringify({ ev: "scatter.selfheal.row", scatter_id: job.scatter_id, status: view.status }));
      parentId = await getRenderIdByJobId(env, job.scatter_id);
    }
    // #33: also backfill any MISSING shard rows. finalizeScatterSubmit writes the parent then the shard-row
    // BATCH as separate D1 ops; a blip between them (parent committed, shards not) leaves the shards
    // permanently absent from /api/storyboard/renders + getScatterChildren -- the render still completes
    // (gather runs off the R2 doc), but the per-shard rows never appear. Reconcile the expected shard ids
    // against the rows that exist and insert the gap, linked to the parent; the normal shard-advance path
    // then updates each shard's status. (One indexed getScatterChildren read per scatter advance.)
    if (parentId != null && job.shard_film_ids.length) {
      const existing = new Set((await getScatterChildren(env, parentId)).map((c) => c.job_id));
      for (const shardFilmId of job.shard_film_ids) {
        if (existing.has(shardFilmId)) continue;
        await insertRender(env, {
          jobId: shardFilmId,
          project: job.project,
          bundleKey: job.bundle_key,
          qualityTier: job.quality_tier,
          renderOverrides: job.render_overrides,
          status: "IN_PROGRESS",
          mode: "full",
          projectId: job.project_id ?? null,
          parentId,
          motionBackend: job.motion_backend ?? null,
        });
        console.log(JSON.stringify({ ev: "scatter.selfheal.shard", scatter_id: job.scatter_id, shard: shardFilmId }));
      }
    }
  } catch (e) {
    if (!isTransientD1Error(e)) {
      console.log(JSON.stringify({ ev: "d1.error", op: "scatter.selfheal.row", scatter_id: job.scatter_id, code: d1ErrorCode(e) }));
    }
    // never abort the advance for a projection-row write; a transient retries on the next poll.
  }
}

export async function advanceScatterJob(
  env: Env,
  scatterId: string,
  ctx?: ExecutionContext,
): Promise<RunpodJobView | null> {
  const job = await loadScatterJob(env, scatterId);
  if (!job) return null;
  // #289 self-heal: the submit writes the R2 doc before the D1 rows, so a mid-submit blip can
  // leave a runnable render whose UI-list row never got written. Insert it if missing (cheap read
  // first; no-op once it exists) so the render shows up and its terminal status/output get logged.
  await ensureScatterRenderRow(env, job, ctx);
  if (job.cancelled) return scatterJobToPollView(job);
  if (job.phase === "done" || job.phase === "failed") return scatterJobToPollView(job);

  // #23: the film is assembled+muxed but an async film.finish (title/credit card) is still in flight.
  // Re-drive ONLY the finish chain (resuming its persisted polls) and finalize once complete -- the
  // shards are already done, so skip the shard-advance loop entirely.
  if (job.phase === "finishing") {
    await maybeFinalizeScatter(env, job);
    await saveScatterJob(env, job);
    const fview = scatterJobToPollView(job);
    if (fview.status !== "IN_PROGRESS") await updateRenderFromView(env, fview, ctx);
    return fview;
  }

  const shardStatuses: ShardStatus[] = [];
  const present = new Set<string>();

  // cf#515 Mode C: discover the module registry ONCE for the whole request and hand it to every
  // shard. Each shard advance used to fan out one `/module.json` subrequest per bound module, so the
  // cost was SHARDS x MODULES -- measured with the suite's counter at 54 for S=2 and 162 for S=6 on
  // a 27-module catalogue, against a 1000-subrequest request ceiling. #521 already fixed the
  // per-leg case INSIDE one film and its comment records why (per-leg discovery once blew the
  // free-plan 50-subrequest cap); its bound is per-FILM, and this loop runs S films per request, so
  // it multiplied the very thing #521 bounded.
  //
  // Discovered HERE rather than at the top of the function so the early-return paths (cancelled,
  // done, failed, finishing) still pay nothing: a fan-out on a path that advances no shard would be
  // a new cost introduced by a change whose whole purpose is removing one.
  const modules = await discoverModules(env as unknown as Record<string, unknown>);

  // core#181: each advanced shard's render-row UPDATE is PREPARED in the loop and issued as ONE
  // batch below, in place of the N sequential D1 round trips this loop used to pay -- the same
  // `env.DB.batch()` the submit path in this file already uses for its N shard inserts.
  //
  // Only the WRITES are batched. The advances are not statements and cannot be folded into a batch:
  // each is a full orchestration tick with its own lease, R2 reads and module fan-out. Whether the
  // advances should also run CONCURRENTLY is a separate question with a different trade-off (it
  // multiplies in-flight subrequests inside one invocation, against the subrequest budget --
  // vivijure-cf#512) and is deliberately NOT answered here.
  const rowUpdates: Array<{ shardIdx: number; prepared: PreparedRenderUpdate; doneShots: string[] }> = [];

  for (let i = 0; i < job.shard_film_ids.length; i++) {
    const filmId = job.shard_film_ids[i];
    const shots = job.shard_shots[i] ?? [];
    // Per-shard isolation (defense-in-depth, pairs with withD1Retry #229): a shard whose advance
    // ERRORS this tick (a transient D1/R2 blip outliving the in-tick retries, or any mid-advance
    // throw) is UNDETERMINED, not dead -- the catch keeps it IN_PROGRESS so the gather waits and
    // retries next tick instead of declaring its shots "owning shard dead", and one shard's error
    // no longer aborts the others' advance. Genuinely-dead still fails fast: a `failed` film phase
    // or a vanished film-job doc (null) both map to FAILED. A permanently-stuck shard is still
    // backstopped by the film job's own hard-deadline (it eventually reports phase=failed).
    let status: string;
    try {
      const r = await advanceFilmJob(env, filmId, modules);
      if (r) {
        // Prepared INSIDE the per-shard try: building the view can itself do per-shard work (the
        // #99 output_key adoption HEAD), and a throw there must isolate to this shard exactly as
        // the write it replaces did.
        const prepared = await prepareRenderUpdate(env, filmJobToPollView(r.job, r.clipJob));
        status = shardStatusForOutcome({ ok: true, job: r.job });
        const doneShots: string[] = [];
        if (r.job.phase === "done") {
          for (const [shotId] of (await clipKeysFromFilmJob(env, r.job)).entries()) {
            doneShots.push(shotId);
          }
        }
        // HELD, not applied. The old ordering wrote the row BEFORE reading the clip keys, so a
        // throwing write left the shard UNDETERMINED and withheld its shots from the gather. The
        // shots therefore land in `present` only once the batch below has landed, which keeps that
        // coupling rather than quietly letting a gather finish on top of an unwritten projection.
        rowUpdates.push({ shardIdx: i, prepared, doneShots });
      } else {
        status = shardStatusForOutcome({ ok: false, reason: "doc_missing" });
      }
    } catch (e) {
      const kind = isTransientD1Error(e) ? "transient D1" : "advance error";
      console.warn(
        `scatter ${scatterId} shard ${filmId} undetermined (${kind}); treating as in-progress, will retry: ${(e as Error).message}`,
      );
      status = shardStatusForOutcome({ ok: false, reason: "errored" });
    }
    shardStatuses.push({ status, shots });
  }

  // core#181: ONE round trip for every advanced shard's row, in place of N.
  if (rowUpdates.length) {
    try {
      await runPreparedRenderUpdates(
        env,
        rowUpdates.map((u) => u.prepared),
        ctx,
        "scatter.gather.shard-rows",
      );
      for (const u of rowUpdates) for (const shotId of u.doneShots) present.add(shotId);
    } catch (e) {
      // A D1 batch is one transaction, so a rejection means NO row moved -- the same condition the
      // per-shard catch above handles one shard at a time, true of every shard in the batch at
      // once. Each contributing shard is therefore downgraded to UNDETERMINED (IN_PROGRESS, not
      // dead) with its done-shots withheld, which is exactly the state the old code left a shard in
      // when its own write threw. A shard that never reached a write (doc_missing, or an advance
      // that threw) is NOT in `rowUpdates` and keeps the status it already has, so a batch failure
      // cannot resurrect a genuinely-dead shard either. The tick itself never fails on a projection
      // write.
      for (const u of rowUpdates) {
        shardStatuses[u.shardIdx].status = shardStatusForOutcome({ ok: false, reason: "errored" });
      }
      const kind = isTransientD1Error(e) ? "transient D1" : "row-write error";
      console.warn(
        `scatter ${scatterId} shard row batch failed (${kind}); ${rowUpdates.length} shard(s) undetermined, will retry: ${(e as Error).message}`,
      );
    }
  }

  // #26: shards/gather/mux are chained as if/else-if so a phase is driven AT MOST ONCE per tick.
  // advanceScatterGather chains forward INTERNALLY (assembleScatterClips -> muxScatterAudio ->
  // maybeFinalizeScatter), so when the "shards" block transitions to gather and drives it, and the
  // assemble transport returns "retry" (leaving job.phase = "gather") or the gather chains into "mux",
  // the sequential gather/mux blocks must NOT re-drive the same phase this tick -- that double-POSTed the
  // video-finish container and incremented assemble_attempts twice. The else-if drives only the entry
  // phase; a transient resumes next tick.
  if (job.phase === "shards") {
    const decision = gatherDecision([...present], job.expected_shot_ids, shardStatuses);
    if (decision.kind === "failed") {
      job.phase = "failed";
      job.error = decision.reason;
      await markRenderFailedByJobId(env, scatterId, decision.reason);
    } else if (decision.kind === "finish") {
      job.phase = "gather";
      await advanceScatterGather(env, job);
    }
  } else if (job.phase === "gather") {
    await advanceScatterGather(env, job);
  } else if (job.phase === "mux") {
    await muxScatterAudio(env, job);
    await maybeFinalizeScatter(env, job);
  }

  await saveScatterJob(env, job);
  const view = scatterJobToPollView(job);
  if (view.status !== "IN_PROGRESS") await updateRenderFromView(env, view, ctx);
  return view;
}

export function scatterJobToPollView(job: ScatterJob): RunpodJobView {
  let status: RunpodStatus;
  let output: Record<string, unknown> | undefined;

  if (job.cancelled) {
    status = "CANCELLED";
  } else if (job.phase === "done") {
    status = "COMPLETED";
    output = scatterDonePayload(job); // core#205: same builder finalizeScatterDone uses

  } else if (job.phase === "failed") {
    status = "FAILED";
  } else {
    status = "IN_PROGRESS";
    output = {
      phase: job.phase,
      project: job.project,
      shards: job.shard_film_ids.length,
      scene_total: job.expected_shot_ids.length,
    };
  }

  return {
    jobId: job.scatter_id,
    status,
    statusRaw: job.phase,
    output,
    error: job.error,
    executionTimeMs: Math.max(0, Date.now() - job.created_at),
  };
}

export async function cancelScatterJob(env: Env, scatterId: string): Promise<RunpodJobView | null> {
  const job = await loadScatterJob(env, scatterId);
  if (!job) return null;
  if (job.phase === "done" || job.phase === "failed") return scatterJobToPollView(job);
  job.cancelled = true;
  job.phase = "failed";
  job.error = "cancelled";
  for (const filmId of job.shard_film_ids) {
    await cancelFilmJob(env, filmId);
  }
  await saveScatterJob(env, job);
  return scatterJobToPollView(job);
}
