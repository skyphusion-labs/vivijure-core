// Planner beat analysis via the installed beat-sync score module (registry-driven).
//
// When MODULE_BEAT_SYNC is bound, POST /api/audio/analyze invokes the module worker, which calls
// the always-on audio-beat-sync container. Falls back to a direct fetch of AUDIO_BEAT_SYNC_URL
// when the module is not installed (legacy path).

import { invokeRegistered } from "./modules/invoke-registered.js";
import type { Env } from "./platform/orchestrator-context.js";
import { isMediaFinishAuthError, mediaDoorFetch, mediaFinishHeaders } from "./media-finish-auth.js";
import {
  discoverModules,
  resolveFetcher,
  validateConfig,
} from "./modules/registry.js";
import { scoreModulesOfKind } from "./modules/score-select.js";
import type { RegisteredModule, ScoreInput } from "./modules/types.js";
import { presignR2Get } from "./presign.js";
import {
  type AudioAnalyzeRequest,
  type AudioBeatPlan,
  parseAudioBeatPlan,
} from "./runpod-submit.js";

interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

/** Score modules that analyze beat timing: those that declare score_kind "beat" (vivijure-cf#878). */
export function beatSyncScoreModules(modules: RegisteredModule[]): RegisteredModule[] {
  return scoreModulesOfKind(modules, "beat");
}

function fetcherForModule(env: Env, mod: RegisteredModule): FetcherLike | null {
  return resolveFetcher(env as unknown as Record<string, unknown>, mod.binding);
}

function resolveBeatSyncModule(
  modules: RegisteredModule[],
  moduleName?: string,
): RegisteredModule | null {
  const candidates = beatSyncScoreModules(modules);
  if (candidates.length === 0) return null;
  if (moduleName) return candidates.find((m) => m.name === moduleName) ?? null;
  return candidates[0];
}

interface BeatSyncModuleOutput {
  film_key: string;
  applied: string[];
  beat_plan?: AudioBeatPlan;
}

export function beatPlanFromModuleOutput(output: BeatSyncModuleOutput | null | undefined): AudioBeatPlan | null {
  const plan = output?.beat_plan;
  if (!plan || (plan.mode !== "beat" && plan.mode !== "duration")) return null;
  return plan;
}

function userConfigFromRequest(req: AudioAnalyzeRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof req.clipSeconds === "number") out.clip_seconds = req.clipSeconds;
  if (req.mode === "beat" || req.mode === "duration") out.mode = req.mode;
  if (typeof req.minSceneS === "number") out.min_scene_s = req.minSceneS;
  if (typeof req.maxSceneS === "number") out.max_scene_s = req.maxSceneS;
  if (typeof req.forceShots === "number") out.force_shots = req.forceShots;
  return out;
}

/** Transport outcome first, content second.
 *
 * The caller (failIfSongBeatsUnread) FAILS a paid film on a permanent miss, so this door has to
 * say which kind of miss it had. A door that is unset, or set with no bearer, is host
 * configuration and never improves by retrying: permanent. A 5xx, a body that will not parse, and
 * a fetch that rejects are all the container being down, restarting, overloaded or behind an edge
 * error page: transient. A 4xx is the container ANSWERING and refusing, so it is permanent, except
 * 408 and 429, which mean "come back" (core#358, see beatDoorStatusTransient). A 200 whose body
 * parses and is not a plan is the analyzer answering with something unusable: permanent (the
 * #245/#249 distinction).
 *
 * The two shapes this corrects: a 502 carrying a JSON body read as an unrecognized plan, and a
 * 502 carrying an HTML body THREW out of resp.json() and past the caller attempt counter
 * entirely, so the cap never engaged on that shape at all. Both retry now. */
/** core#358: whether a non-2xx from the URL beat door is worth another attempt. A 4xx is the
 *  container up and refusing: a 400 is a request it will refuse again, and a 404 on this door means
 *  it has no `/analyze` route, a deploy or config mismatch that no retry fixes. Retrying either
 *  burned the full attempt cap for the same verdict. 408 (request timeout) and 429 (too many
 *  requests) do mean "come back", so they stay transient. Every other status (5xx, and any 1xx or
 *  3xx that reaches here) stays transient, the safe direction for a paid film. */
export function beatDoorStatusTransient(status: number): boolean {
  if (status >= 400 && status < 500) return status === 408 || status === 429;
  return true;
}

async function analyzeViaUrl(
  env: Env,
  audioUrl: string,
  req: AudioAnalyzeRequest,
): Promise<{ ok: true; plan: AudioBeatPlan } | { ok: false; error: string; transient: boolean }> {
  let resp: Response | null;
  try {
    resp = await mediaDoorFetch(env, "AUDIO_BEAT_SYNC_URL", "/analyze", {
      method: "POST",
      headers: await mediaFinishHeaders(env),
      body: JSON.stringify({
        audioUrl,
        audioKey: req.audioKey,
        clipSeconds: req.clipSeconds ?? 8,
        mode: req.mode ?? "beat",
        minSceneS: req.minSceneS ?? 2.5,
        maxSceneS: req.maxSceneS ?? 12,
        forceShots: req.forceShots,
      }),
    });
  } catch (e) {
    if (isMediaFinishAuthError(e)) return { ok: false, error: e.message, transient: false };
    // A rejected fetch is the dead-origin shape (NXDOMAIN, connection reset). It is REPORTED, not
    // rethrown: the caller counts attempts off the return value, and a throw skips that counter.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "beat-sync door unreachable: " + msg.slice(0, 200), transient: true };
  }
  if (!resp) return { ok: false, error: "AUDIO_BEAT_SYNC_URL unset", transient: false };
  if (!resp.ok) {
    return {
      ok: false,
      error: `beat-sync container returned HTTP ${resp.status}`,
      transient: beatDoorStatusTransient(resp.status),
    };
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: "beat-sync container returned an unreadable body: " + msg.slice(0, 200),
      transient: true,
    };
  }
  const plan = parseAudioBeatPlan(body);
  if (!plan) return { ok: false, error: "beat-sync container returned an unrecognized plan", transient: false };
  return { ok: true, plan };
}

export type BeatAnalyzeResult =
  | { ok: true; plan: AudioBeatPlan; module: string }
  | { ok: false; error: string; transient: boolean };

export async function analyzeAudioBeats(
  env: Env,
  req: AudioAnalyzeRequest,
  moduleName?: string,
  preModules?: RegisteredModule[],
  context?: { job_id: string; project: string },
): Promise<BeatAnalyzeResult> {
  const audioKey = req.audioKey?.trim();
  if (!audioKey) return { ok: false, error: "audioKey required", transient: false };

  let audioUrl: string;
  try {
    audioUrl = await presignR2Get(env, audioKey, 300);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "could not presign audio: " + msg.slice(0, 200), transient: true };
  }

  const modules = preModules ?? await discoverModules(env as unknown as Record<string, unknown>);
  const mod = resolveBeatSyncModule(modules, moduleName?.trim() || undefined);

  if (mod) {
    const fetcher = fetcherForModule(env, mod);
    if (!fetcher) {
      return {
        ok: false,
        error: `beat-sync module "${mod.name}" binding ${mod.binding} is not reachable`,
        transient: false,
      };
    }

    const config = {
      ...validateConfig(mod.config_schema, userConfigFromRequest(req)),
      audio_url: audioUrl,
      audio_key: audioKey,
    };

    // A film passes its own ids. The planner sentinel stays only when no film context is given,
    // so a film's beat read is not accounted as a planner job.
    const accounted = context
      ? { job_id: context.job_id, project: context.project }
      : { job_id: crypto.randomUUID(), project: "planner" };
    const filmKey = context ? `beat-analyze/${context.job_id}` : "beat-analyze/planner";

    const r = await invokeRegistered<ScoreInput, BeatSyncModuleOutput>(env, mod, fetcher, {
      hook: "score",
      input: { film_key: filmKey, seconds: 0 },
      config,
      context: accounted,
    });

    // transient is the invoke result, not a substring of r.error. A module error string
    // does not have to contain "invoke failed".
    if (!r.ok) return { ok: false, error: r.error || `${mod.name} invoke failed`, transient: true };
    if (!("output" in r)) {
      return { ok: false, error: `${mod.name} returned async poll (beat analysis is synchronous)`, transient: false };
    }
    const plan = beatPlanFromModuleOutput(r.output);
    if (!plan) return { ok: false, error: `${mod.name} finished but returned no beat plan`, transient: false };
    return { ok: true, plan, module: mod.name };
  }

  const direct = await analyzeViaUrl(env, audioUrl, req);
  if (!direct.ok) return { ok: false, error: direct.error, transient: direct.transient };
  return { ok: true, plan: direct.plan, module: "core-url" };
}
