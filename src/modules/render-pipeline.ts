// Render-pipeline resolution: the core's half of render-flow dispatch.
//
// Given the installed module registry and the user's per-hook selection (from the self-assembling
// pipeline UI), DECIDE which module serves each render hook: motion.backend (pick one), finish,
// score, and speech (chains, in ui.order), each with its user config clamped against the module's schema. The
// core only RESOLVES here; EXECUTION of these hooks happens on the GPU/cloud side (the backend, or a
// downstream invoker) -- this is the plan it hands off. Pure + dependency-free, so it unit-tests
// without bindings.

import type { HookName, RegisteredModule } from "./types.js";
import { servingForHook, validateConfig } from "./registry.js";

/** One resolved module in a render pipeline: who serves the hook + the clamped config to send it. */
export interface ResolvedModule {
  name: string;
  binding: string;
  config: Record<string, unknown>;
}

/** The render pipeline the core resolved from the registry + selection. `motion_backend` is null
 *  when no module serves it (the backend's built-in path runs); the chains are empty when none. */
export interface RenderPipelinePlan {
  motion_backend: ResolvedModule | null;
  keyframe: ResolvedModule | null;
  finish: ResolvedModule[];
  score: ResolvedModule[];
  speech: ResolvedModule[];
  filmFinish: ResolvedModule[];
  master: ResolvedModule[];
}

/** The user's per-hook selection (mirrors the studio UI / window.__pipeline). `config` is keyed by
 *  module name; unknown/missing values fall back to each field's default during clamping. The
 *  *_backend_choice fields select WHICH module serves a pick_one hook that has more than one installed
 *  (e.g. cloud-keyframe vs the GPU keyframe module); omitted = the ui.order default. */
export interface RenderPipelineSelection {
  motion_backend_choice?: string;
  keyframe_backend_choice?: string;
  config?: Record<string, Record<string, unknown>>;
}

function resolve(m: RegisteredModule, userConfig: Record<string, unknown> | undefined): ResolvedModule {
  return { name: m.name, binding: m.binding, config: validateConfig(m.config_schema, userConfig) };
}

/** Pure: pick the single module that serves a `pick_one` hook. An explicit `choice` (the planner's
 *  backend pick) wins so a user can override the ui.order default; an unknown choice resolves to null
 *  (the caller treats that as "no module" -- same as motion.backend's built-in fallback). Omitted choice
 *  = the first serving module by ui.order. For the keyframe hook, dual-hook motion doors (e.g.
 *  local-gpu with ui.section "motion") are skipped so they do not steal the global default from the
 *  dedicated RunPod/cloud keyframe modules -- coupling (coupleLocalGpuKeyframeChoice) pairs them when
 *  motion is local (vivijure-local#153). */
export function pickOneForHook(
  modules: RegisteredModule[],
  hook: HookName,
  choice: string | undefined,
): RegisteredModule | null {
  const serving = servingForHook(modules, hook);
  if (choice) return serving.find((m) => m.name === choice) ?? null;
  if (hook === "keyframe") {
    const dedicated = serving.filter((m) => (m.ui?.section ?? "keyframe") === "keyframe");
    if (dedicated.length) return dedicated[0] ?? null;
  }
  return serving[0] ?? null;
}

/** The installed keyframe module that belongs on a local-GPU door (vivijure-local#153).
 *  Prefers a module that serves `keyframe` with ui.locality "local", then a keyframe module whose
 *  name matches the local motion door (dual-hook `local-gpu`). */
export function localKeyframeModule(
  modules: RegisteredModule[],
  motionName?: string,
): RegisteredModule | undefined {
  const serving = servingForHook(modules, "keyframe");
  const byLocality = serving.find((m) => (m.ui?.locality ?? "cloud") === "local");
  if (byLocality) return byLocality;
  if (motionName) return serving.find((m) => m.name === motionName);
  return undefined;
}

/** When motion is a local GPU door, default an omitted keyframe choice onto the matching local
 *  keyframe module so a film never silently routes keyframes through RunPod (vivijure-local#153).
 *  An explicit keyframe_backend_choice is left alone; submit-path preflight rejects a non-local pick. */
export function coupleLocalGpuKeyframeChoice(
  modules: RegisteredModule[],
  motionChoice: string | undefined,
  keyframeChoice: string | undefined,
): string | undefined {
  const motion = pickOneForHook(modules, "motion.backend", motionChoice);
  if (!motion || (motion.ui?.locality ?? "cloud") !== "local") {
    // Normalize whitespace-only to omitted so callers never carry a blank "choice".
    const trimmed = (keyframeChoice ?? "").trim();
    return trimmed || undefined;
  }
  const trimmed = (keyframeChoice ?? "").trim();
  if (trimmed) return trimmed;
  return localKeyframeModule(modules, motion.name)?.name;
}

/** Resolve the full render pipeline. pick_one hooks (motion.backend, keyframe) honor an optional
 *  backend choice (default is the first serving module by ui.order); chains (finish, score, speech,
 *  film.finish, master) fold every serving module in ui.order. When motion is locality "local",
 *  an omitted keyframe choice couples to the local keyframe module (vivijure-local#153). */
export function resolveRenderPipeline(
  modules: RegisteredModule[],
  selection: RenderPipelineSelection = {},
): RenderPipelinePlan {
  const cfg = selection.config ?? {};
  const chain = (hook: HookName): ResolvedModule[] =>
    servingForHook(modules, hook).map((m) => resolve(m, cfg[m.name]));
  const motion = pickOneForHook(modules, "motion.backend", selection.motion_backend_choice);
  const keyframeChoice = coupleLocalGpuKeyframeChoice(
    modules,
    selection.motion_backend_choice,
    selection.keyframe_backend_choice,
  );
  const keyframe = pickOneForHook(modules, "keyframe", keyframeChoice);
  return {
    motion_backend: motion ? resolve(motion, cfg[motion.name]) : null,
    keyframe: keyframe ? resolve(keyframe, cfg[keyframe.name]) : null,
    finish: chain("finish"),
    score: chain("score"),
    speech: chain("speech"),
    filmFinish: chain("film.finish"),
    master: chain("master"),
  };
}
