// RunPod-shaped poll contract types (extracted from vivijure runpod-submit.ts).

export function coerceQualityTier(t: unknown): "draft" | "standard" | "final" | undefined {
  if (t === "draft") return "draft";
  if (t === "standard") return "standard";
  if (t === "final") return "final";
  return undefined;
}

export type RunpodStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export interface RunpodJobView {
  jobId: string;
  status: RunpodStatus;
  statusRaw: string;
  output?: unknown;
  error?: string;
  executionTimeMs?: number;
  delayTimeMs?: number;
}

export function deriveProjectFromBundleKey(bundleKey: string): string {
  const m = bundleKey.match(/^bundles\/(.+)\.tar\.gz$/);
  if (m) return m[1];
  return bundleKey;
}
