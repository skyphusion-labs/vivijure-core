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

export function sanitizeKeySegment(raw: string, fallback = "project"): string {
  const s = raw
    .replace(/[^A-Za-z0-9._\-]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^[._-]+/, "");
  return s.length > 0 ? s : fallback;
}
