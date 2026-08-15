// Registry-driven render module config: the wire shape the planner sends as render_overrides
// and the core resolves into per-hook module configs before starting a film job.

import {
  coupleLocalGpuKeyframeChoice,
  resolveRenderPipeline,
  pickOneForHook,
  type RenderPipelineSelection,
} from "./modules/render-pipeline.js";
import { servingForHook } from "./modules/registry.js";
import { HOOK_NAMES, type HookName, type HookSelection, type RegisteredModule, type RenderConfigProjection, type RenderHookSelection } from "./modules/types.js";

export type RenderTier = "draft" | "standard" | "final";

export interface QualityTierOption {
  value: RenderTier;
  label: string;
  blurb: string;
}

export const QUALITY_TIERS: readonly QualityTierOption[] = [
  { value: "draft", label: "draft", blurb: "33 frames, 8 steps; fastest, lowest quality" },
  { value: "standard", label: "standard", blurb: "8-step keyframes + 20-step EasyCache i2v; balanced" },
  { value: "final", label: "final", blurb: "97 frames, 22 steps; production quality" },
];

export const DEFAULT_QUALITY_TIER: RenderTier = "final";

export function renderConfigProjection(): RenderConfigProjection {
  return {
    quality_tiers: QUALITY_TIERS.map((t) => ({ value: t.value, label: t.label, blurb: t.blurb })),
    default_tier: DEFAULT_QUALITY_TIER,
  };
}

export interface ModuleRenderOverridesWire {
  motion_backend?: string;
  keyframe_backend?: string;
  config?: Record<string, Record<string, unknown>>;
  /** cf#537: the caller's per-render participation statement, keyed by hook.
   *
   *  It lives INSIDE the overrides bag rather than beside it for two measured reasons. (1) All three
   *  panel frontends shallow-merge every top-level expert-JSON key into this bag, so a user on an
   *  un-updated App Store / Play Store build can express a selection today with no app release; a
   *  field beside the bag would need a store round trip on two clients we cannot update in lockstep.
   *  (2) The replay paths (regen-shot, finalize, animate-cloud, animate-hybrid) send no render config
   *  at all and replay `renders.render_overrides` -- inside the bag a derived render inherits the
   *  selection for free, beside it every derived render silently loses it, which is the original
   *  defect wearing a new hat. */
  select?: RenderHookSelection;
}

export interface ResolvedModuleRenderConfigs {
  motion_backend?: string;
  keyframe_backend?: string;
  keyframe_config: Record<string, unknown>;
  motion_config: Record<string, unknown>;
  finish_config: Record<string, Record<string, unknown>>;
  speech_config: Record<string, Record<string, unknown>>;
  film_finish_config: Record<string, Record<string, unknown>>;
  master_config: Record<string, Record<string, unknown>>;
  /** cf#537: the resolved per-render finish participation, carried to the film job as its own field.
   *  ABSENT here means the caller sent none -- it must NEVER be derived from `finish_config`, whose
   *  Record shape cannot distinguish "no config" from "not requested" after a JSON round trip. That
   *  conflation is the defect this exists to prevent. */
  finish_select?: HookSelection;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** cf#537: parse the wire `select` bag. Entries for UNKNOWN hook names are dropped (the rest of this
 *  parser drops unknown keys too); entries for KNOWN hooks are carried whether or not the hook is
 *  selectable, because the per-hook gate lives in exactly one place (`selectForChain`) and a second
 *  copy here would be a second thing to keep in sync.
 *
 *  A MALFORMED entry is dropped rather than coerced into a mode. That is deliberate and it is the
 *  safe direction: a dropped entry resolves to the default-participation set, which still excludes
 *  every `participation: "opt_in"` module. Inventing `{ mode: "named" }` from `{ modules: [...] }`
 *  with no tag, or treating a bad value as "run everything", would both put an opt-in module back on
 *  a render nobody asked it for. */
export function parseHookSelection(raw: unknown): RenderHookSelection | undefined {
  if (!isRecord(raw)) return undefined;
  const known = new Set<string>(HOOK_NAMES);
  const out: RenderHookSelection = {};
  for (const [hook, v] of Object.entries(raw)) {
    if (!known.has(hook) || !isRecord(v)) continue;
    if (v.mode === "default") {
      out[hook as HookName] = { mode: "default" };
    } else if (v.mode === "named" && Array.isArray(v.modules)) {
      // An empty array survives as an empty array: "explicitly zero modules" is a value, not an absence.
      const modules = (v.modules as unknown[])
        .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
        .map((n) => n.trim());
      out[hook as HookName] = { mode: "named", modules };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function parseModuleRenderOverrides(raw: unknown): ModuleRenderOverridesWire {
  if (!isRecord(raw)) return {};
  // cf#537: `select` joins the modern-shape discriminator. Without it, a bag carrying ONLY a
  // selection falls through to the legacy keyframe/i2v mapping below and the selection is dropped --
  // silently, and in the direction that keeps running the module the caller was trying to exclude.
  if (
    isRecord(raw.config) ||
    isRecord(raw.select) ||
    typeof raw.motion_backend === "string" ||
    typeof raw.keyframe_backend === "string"
  ) {
    const out: ModuleRenderOverridesWire = {};
    // Whitespace-only backend names are omitted (not an explicit choice). Coupling then defaults a
    // local motion door onto a local keyframe module without a preflight/resolve mismatch (#153 audit).
    if (typeof raw.motion_backend === "string" && raw.motion_backend.trim()) {
      out.motion_backend = raw.motion_backend.trim();
    }
    if (typeof raw.keyframe_backend === "string" && raw.keyframe_backend.trim()) {
      out.keyframe_backend = raw.keyframe_backend.trim();
    }
    if (isRecord(raw.config)) {
      const config: Record<string, Record<string, unknown>> = {};
      for (const [name, cfg] of Object.entries(raw.config)) {
        if (isRecord(cfg)) config[name] = { ...cfg };
      }
      if (Object.keys(config).length) out.config = config;
    }
    const select = parseHookSelection(raw.select);
    if (select) out.select = select;
    return out;
  }

  const config: Record<string, Record<string, unknown>> = {};
  const kf = raw.keyframe;
  if (isRecord(kf)) {
    const mapped: Record<string, unknown> = {};
    if (typeof kf.steps === "number") mapped.steps = kf.steps;
    if (typeof kf.guidance_scale === "number") mapped.guidance_scale = kf.guidance_scale;
    if (typeof kf.seed === "number" && kf.seed >= 0) mapped.seed = kf.seed;
    if (typeof kf.resolution === "string") {
      const m = kf.resolution.trim().match(/^(\d+)x(\d+)$/i);
      if (m) {
        mapped.width = parseInt(m[1], 10);
        mapped.height = parseInt(m[2], 10);
      }
    }
    if (Object.keys(mapped).length) config.keyframe = mapped;
  }
  const i2v = raw.i2v;
  if (isRecord(i2v)) {
    const mapped: Record<string, unknown> = {};
    if (typeof i2v.fps === "number") mapped.fps = i2v.fps;
    if (typeof i2v.flow_shift === "number") mapped.flow_shift = i2v.flow_shift;
    if (typeof i2v.seed === "number" && i2v.seed >= 0) mapped.seed = i2v.seed;
    if (Object.keys(mapped).length) config["own-gpu"] = mapped;
  }
  return Object.keys(config).length ? { config } : {};
}

function injectQualityTier(
  config: Record<string, Record<string, unknown>>,
  tier: RenderTier,
  modules: RegisteredModule[],
  keyframeChoice?: string,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(config)) out[name] = { ...cfg };

  const kf = pickOneForHook(modules, "keyframe", keyframeChoice) ?? servingForHook(modules, "keyframe")[0];
  if (kf) {
    out[kf.name] = { ...(out[kf.name] ?? {}), quality_tier: tier };
  }
  for (const m of servingForHook(modules, "motion.backend")) {
    if (m.config_schema?.quality) {
      out[m.name] = { ...(out[m.name] ?? {}), quality: tier };
    }
  }
  return out;
}

export function resolveModuleRenderConfigs(
  overrides: unknown,
  tier: RenderTier,
  modules: RegisteredModule[],
): ResolvedModuleRenderConfigs {
  const parsed = parseModuleRenderOverrides(overrides);
  // Couple BEFORE injectQualityTier so quality_tier lands on the local keyframe module when
  // motion is locality "local" and the caller omitted keyframe_backend (vivijure-local#153).
  const keyframeChoice = coupleLocalGpuKeyframeChoice(
    modules,
    parsed.motion_backend,
    parsed.keyframe_backend,
  );
  const config = injectQualityTier(parsed.config ?? {}, tier, modules, keyframeChoice);
  const selection: RenderPipelineSelection = {
    motion_backend_choice: parsed.motion_backend,
    keyframe_backend_choice: keyframeChoice,
    config,
    select: parsed.select,
  };
  const pipeline = resolveRenderPipeline(modules, selection);

  const keyframe_config = pipeline.keyframe ? pipeline.keyframe.config : { quality_tier: tier };

  const finish_config: Record<string, Record<string, unknown>> = {};
  for (const m of pipeline.finish) finish_config[m.name] = m.config;

  const speech_config: Record<string, Record<string, unknown>> = {};
  for (const m of pipeline.speech) speech_config[m.name] = m.config;

  const film_finish_config: Record<string, Record<string, unknown>> = {};
  for (const m of pipeline.filmFinish) film_finish_config[m.name] = m.config;
  const master_config: Record<string, Record<string, unknown>> = {};
  for (const m of pipeline.master) master_config[m.name] = m.config;

  return {
    motion_backend: pipeline.motion_backend?.name,
    keyframe_backend: pipeline.keyframe?.name,
    keyframe_config,
    motion_config: pipeline.motion_backend?.config ?? {},
    finish_config,
    speech_config,
    film_finish_config,
    master_config,
    // cf#537: carried as its own field. The finish set is derived TWICE and independently -- here at
    // resolve time (for config) and again at mint time from the LIVE registry (film-orchestrator's
    // enterFinishPhase). The mint site does not read this resolved plan, so a selection that reached
    // only the resolve path would be discarded with nothing to notice.
    ...(parsed.select?.finish ? { finish_select: parsed.select.finish } : {}),
  };
}
