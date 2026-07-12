// Storyboard shot-id coercion (pure). Full validator: storyboard-validate.ts.

const SHOT_ID_RE = /^shot_\d+$/;

export function coerceShotId(rawId: string | undefined, index: number): string {
  const desired = `shot_${String(index + 1).padStart(2, "0")}`;
  if (typeof rawId !== "string") return desired;
  const trimmed = rawId.trim();
  if (trimmed.length === 0) return desired;
  return SHOT_ID_RE.test(trimmed) ? trimmed : desired;
}
