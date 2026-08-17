/**
 * Bearer for the fleet media containers (video-finish, audio-mix, audio-beat-sync, image-prep).
 *
 * Those images refuse work when LOCAL_FINISH_TOKEN is set (vivijure-cf#613). Assemble
 * and mux go through this package, so the header has to be attached here or arming
 * the token 401s every film. Unset stays fail-open: a self-host with no token keeps
 * the unauthenticated path.
 *
 * Typed unknown because the host may bind a plaintext string OR a Secrets Store
 * handle. Same resolution shape as tenantR2FromEnv / runpodRoute: a string is used
 * as-is, a `{ get() }` handle is awaited, anything else is absent.
 */
import type { Env } from "./platform/orchestrator-context.js";

export type MediaDoorKey =
  | "VIDEO_FINISH_URL"
  | "AUDIO_MIX_URL"
  | "AUDIO_BEAT_SYNC_URL"
  | "IMAGE_PREP_URL";

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

/** Host-set public origin for a CPU media door. Unset or empty means that door is off. */
export function mediaDoorUrl(env: Env, key: MediaDoorKey): string {
  const raw = env[key];
  return typeof raw === "string" && raw.trim() ? raw.replace(/\/$/, "") : "";
}

/** True when the host set a public origin for this door. */
export function mediaDoorReachable(env: Env, key: MediaDoorKey): boolean {
  return Boolean(mediaDoorUrl(env, key));
}

/** POST a path on a host-configured media door. Returns null when the URL is unset. */
export async function mediaDoorFetch(
  env: Env,
  key: MediaDoorKey,
  path: string,
  init: RequestInit,
): Promise<Response | null> {
  const url = mediaDoorUrl(env, key);
  if (!url) return null;
  return fetch(url + (path.startsWith("/") ? path : "/" + path), init);
}

/** Host-set video-finish origin. Unset or empty disables assemble/mux/inspect. */
export function videoFinishUrl(env: Env): string {
  return mediaDoorUrl(env, "VIDEO_FINISH_URL");
}

/** True when the host set a public video-finish origin. */
export function videoFinishReachable(env: Env): boolean {
  return mediaDoorReachable(env, "VIDEO_FINISH_URL");
}

/** POST a path on video-finish. Returns null when VIDEO_FINISH_URL is unset. */
export async function videoFinishFetch(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<Response | null> {
  return mediaDoorFetch(env, "VIDEO_FINISH_URL", path, init);
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
