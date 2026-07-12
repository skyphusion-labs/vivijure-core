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
