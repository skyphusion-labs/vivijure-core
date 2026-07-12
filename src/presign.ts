// Presign helpers for orchestrators (delegates to platform presigner).

import type { OrchestratorEnv } from "./platform/orchestrator-context.js";

export const FILM_DOWNLOAD_TTL_SECONDS = 3600;

function isPresignSafeKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.startsWith("/")) return false;
  if (key.includes("://")) return false;
  if (/[^ -~]/.test(key)) return false;
  return !key.split("/").includes("..");
}

export async function presignR2Get(env: OrchestratorEnv, key: string, expiresSec = 300): Promise<string> {
  if (!isPresignSafeKey(key)) throw new Error("R2 presign: refusing to sign an unsafe object key");
  return env.PRESIGNER.presignGet(key, expiresSec);
}

export async function presignR2Put(
  env: OrchestratorEnv,
  key: string,
  expiresSec = 300,
  contentType = "application/octet-stream",
): Promise<string> {
  if (!isPresignSafeKey(key)) throw new Error("R2 presign: refusing to sign an unsafe object key");
  return env.PRESIGNER.presignPut(key, contentType, expiresSec);
}
