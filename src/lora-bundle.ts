// Pure helpers for standalone LoRA training bundles.
//
// Route handlers wrap these with env-touching pieces (assembleBundle,
// submitTrainLoraJob). Keeping data-shaping here lets vitest cover the
// bundle-builder logic without importing cloudflare:workers.

import type { StoryboardValidated } from "./storyboard-validate.js";
import type { CastMember } from "./cast-db.js";

export interface LoraBundleTrainingImage {
  key: string;
}

export interface LoraBundleCharacterRef {
  name: string;
  prompt: string;
  trainingImages: LoraBundleTrainingImage[];
  portrait?: LoraBundleTrainingImage;
}

export interface LoraBundleArgs {
  storyboard: StoryboardValidated;
  characterRefs: Record<string, LoraBundleCharacterRef>;
}

// Build the (storyboard, characterRefs) tuple that assembleBundle takes
// for a single-slot LoRA training bundle. The synthesized storyboard
// satisfies the validator: one scene with a non-empty prompt that
// references slot A, which is also the only entry in use_characters.
export function buildLoraTrainingBundleArgs(
  cast: CastMember,
  bundleSuffix: string,
): LoraBundleArgs {
  const safeSlug = cast.slug || `cast-${cast.id}`;
  const projectName = `lora-${safeSlug}-${bundleSuffix}`;
  return {
    storyboard: {
      title: projectName,
      projectName,
      full_prompt: "",
      duration_seconds: undefined,
      clip_seconds: undefined,
      style_prefix: "",
      style_category: "None",
      style_preset: "None",
      use_characters: ["A"],
      cast_rules: "",
      scenes: [
        {
          id: "lora_train_shot",
          prompt: "lora training reference shot (not rendered)",
          character_slots: ["A"],
          target_seconds: 1,
        },
      ],
    },
    characterRefs: {
      A: {
        name: cast.name,
        prompt: cast.bible || cast.name,
        trainingImages: cast.ref_keys.map((r) => ({ key: r.key })),
        portrait: cast.portrait_key ? { key: cast.portrait_key } : undefined,
      },
    },
  };
}

// Build the destination R2 key for the trained .safetensors. Per-cast
// prefix lets a future GC pass enumerate by cast id; the timestamp
// version keeps retraining immutable so an in-flight render that
// references the prior key does not break. The GPU backend may use its
// own convention; this is returned to the client for traceability.
export function deriveLoraDestKey(castId: number, timestamp: number): string {
  return `loras/cast-${castId}/${timestamp}.safetensors`;
}

export interface WanLoraDestKeys {
  high: string;
  low: string;
}

// Destination R2 keys for a trained Wan 2.2 A14B adapter. Wan A14B is a two-expert mixture, so a
// Wan character LoRA is TWO files (high-noise + low-noise); each gets its own timestamped key beside
// the single-file SDXL key. Same per-cast prefix + immutable-timestamp rationale as
// deriveLoraDestKey. The GPU backend uses its own convention; these are for client traceability.
export function deriveWanLoraDestKeys(castId: number, timestamp: number): WanLoraDestKeys {
  return {
    high: `loras/cast-${castId}/${timestamp}.high.safetensors`,
    low: `loras/cast-${castId}/${timestamp}.low.safetensors`,
  };
}

// The two trained-Wan-expert R2 keys from a completed train job envelope. The wan train result nests
// them under result.lora[slot] as { lora_id_high, lora_id_low, family: "wan" } (a cast-training
// bundle is single-slot). This is the SIBLING of extractTrainedLoraKey: that reads the single-file
// SDXL shape (entry.lora_id) and returns null on a wan entry; this reads the two-file wan shape and
// returns null on an sdxl entry. A consumer must pick the one matching the family it trained -- the
// two shapes are handled EXPLICITLY, never assumed. Returns null unless BOTH expert keys are present
// (a half-result is not a trained pair).
export function extractTrainedWanLoraKeys(output: unknown): WanLoraDestKeys | null {
  if (!output || typeof output !== "object") return null;
  const lora = (output as Record<string, unknown>).lora;
  if (!lora || typeof lora !== "object" || Array.isArray(lora)) return null;
  for (const entry of Object.values(lora as Record<string, unknown>)) {
    if (entry && typeof entry === "object") {
      const high = (entry as { lora_id_high?: unknown }).lora_id_high;
      const low = (entry as { lora_id_low?: unknown }).lora_id_low;
      if (typeof high === "string" && high && typeof low === "string" && low) {
        return { high, low };
      }
    }
  }
  return null;
}

export interface WanLoraConfigArrays {
  high_noise_loras: string;
  low_noise_loras: string;
}

// Shape the two presigned expert URLs into the alibaba-wan-lora module config fields
// (high_noise_loras / low_noise_loras), each a JSON string of [{ path, scale }] the module parses.
// SCALE DEFAULTS TO 1.5, NOT 1.0: the Phase-0 spike (cf#29) found scale 1.0 underperformed the
// no-LoRA control (it perturbed the trajectory without asserting identity), while ~1.5 bound the
// character cleanly. Callers may override, but the default must never silently be 1.0.
export function buildWanLoraConfigArrays(
  highUrl: string,
  lowUrl: string,
  scale = 1.5,
): WanLoraConfigArrays {
  return {
    high_noise_loras: JSON.stringify([{ path: highUrl, scale }]),
    low_noise_loras: JSON.stringify([{ path: lowUrl, scale }]),
  };
}

// The trained-LoRA R2 key from a completed train_lora job envelope. The clean-room
// backend returns it nested under result.lora[slot].lora_id (a cast-training bundle
// is single-slot, so it's the one entry); the legacy vivijure-serverless envelope
// used a top-level lora_key. Reads both shapes so the cast page harvests the key
// either way; returns null only if neither carries one.
export function extractTrainedLoraKey(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (typeof o.lora_key === "string" && o.lora_key) return o.lora_key;
  const lora = o.lora;
  if (lora && typeof lora === "object" && !Array.isArray(lora)) {
    for (const entry of Object.values(lora as Record<string, unknown>)) {
      if (entry && typeof entry === "object") {
        const id = (entry as { lora_id?: unknown }).lora_id;
        if (typeof id === "string" && id) return id;
      }
    }
  }
  return null;
}
