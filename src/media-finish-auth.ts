/**
 * Bearer for the fleet media containers (video-finish, audio-mix, audio-beat-sync, image-prep).
 *
 * Those images refuse work when LOCAL_FINISH_TOKEN is set (vivijure-cf#613). Assemble
 * and mux go through this package, so the header has to be attached here or arming
 * the token 401s every film.
 *
 * Fail-closed on a configured public door: if a door URL is set and the token is
 * empty, headers and fetch THROW. An unauthenticated request to a public origin
 * is never sent. Self-host with no door URL stays off (fetch returns null).
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

const MEDIA_DOOR_KEYS: readonly MediaDoorKey[] = [
  "VIDEO_FINISH_URL",
  "AUDIO_MIX_URL",
  "AUDIO_BEAT_SYNC_URL",
  "IMAGE_PREP_URL",
];

/**
 * An in-process door: anything with a `fetch`. In production this is the Durable Object stub that
 * fronts the Cloudflare Container (vivijure-cf `FINISH_CONTAINER`), whose base `Container.fetch()`
 * forwards to the container on its default port.
 *
 * Shape matches `vivijure-cf/src/render-frames.ts` FetcherLike deliberately: one pattern for
 * reaching a container, not two.
 */
export interface MediaDoorFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** In-process fetchers keyed by door. A door present here is reached through the BINDING, and its
 *  public origin is not consulted at all. */
export type MediaDoorFetchers = Partial<Record<MediaDoorKey, MediaDoorFetcher>>;

/**
 * Origin used on the binding path. The hostname is a LABEL, not a name: nothing resolves it, no
 * DNS is consulted and no packet leaves the isolate's request graph. It exists because `fetch`
 * requires an absolute URL.
 */
const MEDIA_DOOR_INTERNAL_ORIGIN: Record<MediaDoorKey, string> = {
  VIDEO_FINISH_URL: "http://video-finish",
  AUDIO_MIX_URL: "http://audio-mix",
  AUDIO_BEAT_SYNC_URL: "http://audio-beat-sync",
  IMAGE_PREP_URL: "http://image-prep",
};

/** The bound in-process fetcher for a door, or null. Duck-typed on `fetch` so a DO stub, a service
 *  binding and a test double are all admissible without importing a Cloudflare type here. */
export function mediaDoorFetcher(env: Env, key: MediaDoorKey): MediaDoorFetcher | null {
  const map = (env as { MEDIA_DOOR_FETCHERS?: MediaDoorFetchers }).MEDIA_DOOR_FETCHERS;
  const bound = map ? map[key] : undefined;
  return bound && typeof bound.fetch === "function" ? bound : null;
}

/** Thrown when a media door URL is set and the bearer is empty. Assemble treats this as a hard fail. */
export class MediaFinishAuthError extends Error {
  readonly code = "MEDIA_FINISH_TOKEN_REQUIRED" as const;
  constructor(door?: string) {
    super(
      door
        ? `${door} is set but MEDIA_FINISH_TOKEN is empty; refusing unauthenticated door request`
        : "a media door URL is set but MEDIA_FINISH_TOKEN is empty; refusing unauthenticated door request",
    );
    this.name = "MediaFinishAuthError";
  }
}

export function isMediaFinishAuthError(e: unknown): e is MediaFinishAuthError {
  return e instanceof MediaFinishAuthError;
}

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

/**
 * True when this door can be reached AT ALL, by binding or by public origin.
 *
 * The binding arm is load-bearing and easy to leave out: every phase gate in the orchestrators
 * (`enterAssemblePhase`, mux, gather, clip validation) calls this, and a binding-only studio with
 * VIDEO_FINISH_URL unset would otherwise degrade to "tier not installed" while the container sat
 * right there, bound and working.
 */
export function mediaDoorReachable(env: Env, key: MediaDoorKey): boolean {
  return Boolean(mediaDoorFetcher(env, key)) || Boolean(mediaDoorUrl(env, key));
}

/** POST a path on a host-configured media door. Returns null when the URL is unset.
 *  Throws MediaFinishAuthError when the URL is set and the bearer is empty. */
export async function mediaDoorFetch(
  env: Env,
  key: MediaDoorKey,
  path: string,
  init: RequestInit,
): Promise<Response | null> {
  const p = path.startsWith("/") ? path : "/" + path;

  // BINDING FIRST (cf#810). A route on our own zone is not reachable by global fetch() from the
  // Worker that serves it -- Cloudflare documents same-zone Worker-to-Worker fetch as failing
  // against a route -- so the hostname shape #797 specified cannot exist for this door. Through
  // the binding there is no DNS, no edge hop, and the container keeps its property of being
  // unreachable from the internet.
  //
  // No bearer is REQUIRED here, and that is not a relaxation. The bearer exists to authenticate a
  // request that crosses the public internet; this one never leaves the isolate's request graph.
  // A token is still SENT when the host set one, because mediaFinishHeaders() attaches it at the
  // call site, so a container image configured with LOCAL_FINISH_TOKEN keeps working unchanged.
  // What changes is only that a MISSING token no longer fails closed on a path that has nothing
  // to fail closed against.
  const bound = mediaDoorFetcher(env, key);
  if (bound) return bound.fetch(MEDIA_DOOR_INTERNAL_ORIGIN[key] + p, init);

  const url = mediaDoorUrl(env, key);
  if (!url) return null;
  const token = await mediaFinishToken(env);
  if (!token) throw new MediaFinishAuthError(key);
  return fetch(url + p, init);
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

/** True when the host set any public media-door origin. */
export function anyMediaDoorUrl(env: Env): MediaDoorKey | "" {
  for (const key of MEDIA_DOOR_KEYS) {
    if (mediaDoorUrl(env, key)) return key;
  }
  return "";
}

/** JSON POST headers, plus Authorization when a token is readable.
 *  Throws when a door URL is set and the token is empty (do not send unauthenticated). */
export async function mediaFinishHeaders(
  env: Env,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  const token = await mediaFinishToken(env);
  const door = anyMediaDoorUrl(env);
  if (door && !token) throw new MediaFinishAuthError(door);
  if (token) headers.authorization = "Bearer " + token;
  return headers;
}
