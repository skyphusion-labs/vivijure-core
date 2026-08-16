// Orchestrator context: Platform -> env-shaped bag for ported vivijure orchestration.
// Hosts may inject VPC fetchers and other bindings after this builder runs.

import type { Database, ObjectPresigner, Platform } from "./types.js";
import { platformAsEnv } from "./types.js";
import type { R2Bucket } from "./r2-types.js";
import { wrapR2Bucket } from "./object-store-r2.js";

/** Minimal ExecutionContext shim (poll bookkeeping uses waitUntil best-effort). */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export const noopExecutionContext: ExecutionContext = {
  waitUntil(promise) {
    void promise.catch((e) => console.warn("waitUntil failed:", e));
  },
};

export interface OrchestratorEnv {
  DB: Database;
  R2_RENDERS: R2Bucket;
  R2: R2Bucket;
  PRESIGNER: ObjectPresigner;
  /**
   * The TENANT's own bucket-scoped R2 credential (cp#270). Present on a provisioned hosted studio
   * (provisioner.ts binds all four) and on any self-host that configured presigning; absent
   * otherwise, which is why every field is optional.
   *
   * DECLARED rather than left to the index signature below, deliberately. The index signature
   * would type-check either way, and that is exactly how this codebase ended up with a
   * `RUNPOD_ENDPOINT_ID` on an Env that nothing reads: an undeclared binding is invisible to
   * every reader and to the compiler. A hand-authored Env is the house rule.
   *
   * Typed `unknown` rather than `string` because a binding here may be a plain string OR a
   * Secrets Store handle, and pretending otherwise would push an unsafe cast onto every reader.
   * Resolve them through `tenantR2FromEnv`, which handles both and treats a failed read as
   * absent.
   */
  R2_S3_ENDPOINT?: unknown;
  R2_S3_ACCESS_KEY_ID?: unknown;
  R2_S3_SECRET_ACCESS_KEY?: unknown;
  R2_S3_BUCKET?: unknown;
  /**
   * The control-plane RunPod proxy pair (cp#321). DECLARED for exactly the reason the comment
   * above gives: the index signature would type-check either way, and an undeclared binding is
   * invisible to every reader and to the compiler -- which is how `RUNPOD_ENDPOINT_ID` ended up
   * on an Env nothing reads.
   *
   * `RUNPOD_PROXY_BASE` is the plane's public origin plus `/api/runpod/v2`, bound plain_text and
   * ONLY for `runpod_mode = 'shared'`. `RUNPOD_PROXY_TOKEN` is the per-tenant plane credential,
   * bound as a secret. BOUND-ness of the base is the whole branch: bound means every RunPod call
   * goes through the plane and this Worker holds no RunPod key; unbound is the untouched direct
   * path, which is the self-host door and is permanently supported. It is never a failover.
   *
   * `unknown` for the same reason as the R2 quartet above: either may be a plain string or a
   * Secrets Store handle, and both are resolved through `runpodRoute` in src/runpod-route.ts.
   */
  RUNPOD_PROXY_BASE?: unknown;
  RUNPOD_PROXY_TOKEN?: unknown;
  /**
   * Bearer the fleet media containers check (video-finish / audio-mix / audio-beat-sync;
   * vivijure-cf#613). Optional: unset is fail-open so a self-host with no token keeps the
   * current unauthenticated VPC path. `unknown` because a host may bind a plaintext string
   * or a Secrets Store handle; resolve through `mediaFinishToken`.
   */
  MEDIA_FINISH_TOKEN?: unknown;
  /**
   * Fallback when MEDIA_FINISH_TOKEN is unbound. The GPU doors already carry this name;
   * a host that has not added a media-specific binding can reuse the same secret.
   */
  FINISH_DOOR_TOKEN?: unknown;
  /**
   * Public origin of the video-finish Traefik SUBMIT name
   * (https://video-finish.skyphusion.org). When set, assemble/mux/inspect use
   * global fetch to this URL instead of VIDEO_FINISH_VPC.
   */
  VIDEO_FINISH_URL?: unknown;
  /** Plain config vars (FILM_CLIP_DURATION_FLOOR, VPC bindings, etc.). */
  [key: string]: unknown;
}

/** Alias for upstream `import type { Env } from "./env"` at port sites. */
export type Env = OrchestratorEnv;

/** Build orchestrator env from Platform (no host VPC injection). */
export function orchestratorContextFromPlatform(platform: Platform): OrchestratorEnv {
  const env = platformAsEnv(platform) as OrchestratorEnv;
  env.DB = platform.db;
  env.R2_RENDERS = wrapR2Bucket(platform.renders);
  env.R2 = wrapR2Bucket(platform.chatBucket);
  env.PRESIGNER = platform.presigner;
  for (const [key, value] of Object.entries(platform.vars)) {
    if (value !== undefined) env[key] = value;
  }
  if (platform.hostBindings) {
    for (const [key, fetcher] of Object.entries(platform.hostBindings)) {
      env[key] = fetcher;
    }
  }
  return env;
}
