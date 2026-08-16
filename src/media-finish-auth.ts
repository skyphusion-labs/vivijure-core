/**
 * Bearer for the fleet media containers (video-finish, audio-mix, audio-beat-sync).
 *
 * Those images refuse work when LOCAL_FINISH_TOKEN is set (vivijure-cf#613). Assemble
 * and mux go through this package, so the header has to be attached here or arming
 * the token 401s every film. Unset stays fail-open: a self-host with no token keeps
 * the current unauthenticated VPC path.
 *
 * Typed unknown because the host may bind a plaintext string OR a Secrets Store
 * handle. Same resolution shape as tenantR2FromEnv / runpodRoute: a string is used
 * as-is, a `{ get() }` handle is awaited, anything else is absent.
 */
import type { Env } from "./platform/orchestrator-context.js";

function asGetter(value: unknown): { get: () => Promise<unknown> } | null {
  if (!value || typeof value !== "object") return null;
  const get = (value as { get?: unknown }).get;
  return typeof get === "function" ? (value as { get: () => Promise<unknown> }) : null;
}

/** Resolve the media-finish bearer. Empty string means "send nothing". */
export async function mediaFinishToken(env: Env): Promise<string> {
  const raw = env.MEDIA_FINISH_TOKEN ?? env.FINISH_DOOR_TOKEN;
  if (typeof raw === "string") return raw.trim();
  const handle = asGetter(raw);
  if (!handle) return "";
  try {
    const got = await handle.get();
    return typeof got === "string" ? got.trim() : "";
  } catch {
    return "";
  }
}

/** Public Traefik SUBMIT origin. Same shape as the GPU door table, not a host VPC binding. */
export const VIDEO_FINISH_SUBMIT = "https://video-finish.skyphusion.org";

/** Public Traefik SUBMIT origin. Host may override VIDEO_FINISH_URL; empty string disables. */
export function videoFinishUrl(env: Env): string {
  const raw = env.VIDEO_FINISH_URL;
  if (raw === "") return "";
  if (typeof raw === "string" && raw.trim()) return raw.replace(/\/$/, "");
  return VIDEO_FINISH_SUBMIT;
}

/** True when the host set a public video-finish origin. No VPC fallback. */
export function videoFinishReachable(env: Env): boolean {
  return Boolean(videoFinishUrl(env));
}

/** POST a path on video-finish over public HTTPS (Traefik SUBMIT). No VPC. */
export async function videoFinishFetch(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<Response | null> {
  const url = videoFinishUrl(env);
  if (!url) return null;
  return fetch(url + (path.startsWith("/") ? path : "/" + path), init);
}

/** JSON POST headers, plus Authorization when a token is readable. */
export async function mediaFinishHeaders(
  env: Env,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  const token = await mediaFinishToken(env);
  if (token) headers.authorization = "Bearer " + token;
  return headers;
}
