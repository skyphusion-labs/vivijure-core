// Motion-door usage envelope: how WE call the backend, which is the
// consistency ceiling. Pure. Modules declare `usage` on the manifest.

import type { MotionUsageDecl, MotionVoiceMode, RegisteredModule } from "./modules/types.js";

const VOICE_MODES = new Set<MotionVoiceMode>([
  "prompt_lock",
  "seed_and_prompt",
  "cast_tts",
  "prev_clip",
]);

export function parseMotionUsage(raw: unknown): MotionUsageDecl | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.native_audio !== "boolean") return undefined;
  if (typeof o.voice !== "string" || !VOICE_MODES.has(o.voice as MotionVoiceMode)) return undefined;
  if (typeof o.scatter_native_audio !== "boolean") return undefined;
  if (typeof o.min_seconds !== "number" || !Number.isFinite(o.min_seconds) || o.min_seconds <= 0) return undefined;
  if (typeof o.max_seconds !== "number" || !Number.isFinite(o.max_seconds) || o.max_seconds < o.min_seconds) {
    return undefined;
  }
  const steps = Array.isArray(o.duration_steps)
    ? o.duration_steps.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0)
    : undefined;
  return {
    native_audio: o.native_audio,
    voice: o.voice as MotionVoiceMode,
    scatter_native_audio: o.scatter_native_audio,
    min_seconds: o.min_seconds,
    max_seconds: o.max_seconds,
    duration_steps: steps && steps.length ? steps : undefined,
    first_last: o.first_last === true,
    seed: o.seed === true,
  };
}

export function usageOf(mod: RegisteredModule | undefined): MotionUsageDecl | undefined {
  return mod ? parseMotionUsage(mod.usage) : undefined;
}

export function generateAudioOn(config: Record<string, unknown> | undefined): boolean {
  if (!config) return true;
  return config.generate_audio !== false;
}

const LOOK_DOORS = new Set(["own-gpu", "local-gpu"]);

/** Talking clips never scatter. Look doors (own-gpu / local-gpu) never
 *  scatter. Silent cloud may scatter unless the door declared it off. */
export function motionScatterAllowed(
  usage: MotionUsageDecl | undefined,
  generateAudio: boolean,
  moduleName?: string,
): boolean {
  const talking = usage ? usage.native_audio && generateAudio : generateAudio;
  if (talking) return false;
  if (moduleName && LOOK_DOORS.has(moduleName)) return false;
  if (usage && usage.scatter_native_audio === false) return false;
  return true;
}

export function usageNeedsVoiceLock(usage: MotionUsageDecl | undefined, generateAudio: boolean): boolean {
  if (!usage || !usage.native_audio || !generateAudio) return false;
  return usage.voice === "prompt_lock" || usage.voice === "seed_and_prompt" || usage.voice === "prev_clip";
}

export function usageLimitLines(usage: MotionUsageDecl): string[] {
  const dur = usage.duration_steps && usage.duration_steps.length
    ? usage.duration_steps.join("/") + "s clips"
    : usage.min_seconds + "-" + usage.max_seconds + "s clips";
  const lines = [dur];
  if (usage.native_audio) {
    if (usage.voice === "seed_and_prompt") {
      lines.push("Same seed + same voice lock on every shot");
    } else if (usage.voice === "prev_clip") {
      lines.push("Each talking shot continues the previous clip's audio");
    } else {
      lines.push("Same voice lock on every shot (no speaker id on this door)");
    }
    lines.push(usage.scatter_native_audio
      ? "Shots render in parallel; this door cannot hear the previous clip"
      : "Talking shots stay on one film (no scatter)");
  } else {
    lines.push("Silent motion; speaking voice is the Cast voice (TTS)");
  }
  if (usage.first_last) lines.push("Each shot animates toward the next still");
  return lines;
}
