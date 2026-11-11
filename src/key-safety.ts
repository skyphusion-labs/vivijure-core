// Safe relative key / path segment helpers (ported from vivijure shared.ts).

export const BUNDLE_KEY_PREFIX = "bundles/";

const REL_KEY_CHARS = /^[A-Za-z0-9._\-\/]+$/;

export function isSafeRelKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.startsWith("/")) return false;
  if (!REL_KEY_CHARS.test(key)) return false;
  return !key.split("/").includes("..");
}

export function isSafeBundleKey(key: unknown): key is string {
  return isSafeRelKey(key) && key.startsWith(BUNDLE_KEY_PREFIX);
}

/** Prefixes the studio serve routes will read. Keep this list the same as
 *  vivijure-cf `ARTIFACT_PREFIXES` and vivijure-local `ARTIFACT_PREFIXES`. */
export const SERVED_ARTIFACT_PREFIXES = [
  "audio/",
  "bundles/",
  "cast/",
  "cast-clean/",
  "cast-gen/",
  "character-refs/",
  "characters/",
  "clips/",
  "loras/",
  "out/",
  "renders/",
  "uploads/",
] as const;

const QUARANTINE_PREFIX = "quarantine/";

/** True when a key is in the served artifact space. A `quarantine/` key is not,
 *  even when the rest of the name looks ordinary. */
export function isServedArtifactKey(key: unknown): key is string {
  if (!isSafeRelKey(key)) return false;
  if (key.startsWith(QUARANTINE_PREFIX)) return false;
  return SERVED_ARTIFACT_PREFIXES.some((pre) => key.startsWith(pre));
}

/** Project-scoped render prefix. Module-returned artifact keys must stay under this. */
export function projectKeyPrefix(project: string): string {
  return `renders/${project}/`;
}

/** True when key is a safe relative key strictly under renders/<project>/. */
export function isProjectKey(project: string, key: unknown): key is string {
  if (typeof project !== "string" || !project || !isSafeRelKey(key)) return false;
  const prefix = projectKeyPrefix(project);
  return key.startsWith(prefix) && key.length > prefix.length;
}

/** Adopt a module-returned artifact key, or throw. Escaping renders/<project>/ is refused.
 *  Bundle keys are not accepted here: clip/keyframe outputs live under renders/. */
export function assertProjectKey(project: string, key: string): string {
  if (!isProjectKey(project, key)) {
    throw new Error(`refused key outside ${projectKeyPrefix(project || "?")}`);
  }
  return key;
}

/**
 * Cast LoRA keys are character-stable (`loras/<id>.safetensors`) so one train
 * is reused across projects. Render-scoped adapters under renders/<project>/
 * are also fine (the bank copies them). Anything else is refused.
 */
export function isBankedLoraKey(key: unknown): key is string {
  if (!isSafeRelKey(key)) return false;
  return key.startsWith("loras/") || key.startsWith("renders/");
}

export function assertBankedLoraKey(key: string): string {
  if (!isBankedLoraKey(key)) {
    throw new Error("refused LoRA key (want loras/ or renders/)");
  }
  return key;
}

export function sanitizeKeySegment(raw: string, fallback = "project"): string {
  const s = raw
    .replace(/[^A-Za-z0-9._\-]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^[._-]+/, "");
  return s.length > 0 ? s : fallback;
}
