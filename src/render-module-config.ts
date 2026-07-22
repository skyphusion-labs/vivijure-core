// Registry-driven render module config: the wire shape the planner sends as render_overrides
// and the core resolves into per-hook module configs before starting a film job.

import {
  coupleLocalGpuKeyframeChoice,
  resolveRenderPipeline,
  pickOneForHook,
  type RenderPipelineSelection,
} from "./modules/render-pipeline.js";
import { servingForHook } from "./modules/registry.js";
import type { RegisteredModule, RenderConfigProjection } from "./modules/types.js";

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
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function parseModuleRenderOverrides(raw: unknown): ModuleRenderOverridesWire {
  if (!isRecord(raw)) return {};
  if (isRecord(raw.config) || typeof raw.motion_backend === "string" || typeof raw.keyframe_backend === "string") {
    const out: ModuleRenderOverridesWire = {};
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
  };
}
