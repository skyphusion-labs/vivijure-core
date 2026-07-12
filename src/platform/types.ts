// Platform abstractions for vivijure-local.
//
// Designed for extraction into vivijure-core@2.x (Option A). Cloudflare Env becomes
// CloudflarePlatform; this repo implements NodePlatform. Keep this file free of Node-only imports
// so it can lift into the shared package unchanged.
//
// ICD: docs/PLATFORM.md -- bump PLATFORM_ICD_VERSION on breaking changes.

/** Frozen host-adapter contract version (Phase 3). */
export const PLATFORM_ICD_VERSION = 1;

/** D1-shaped prepared statement (subset used by vivijure DB helpers). */
export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: { changes?: number; last_row_id?: number } }>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

/** D1-shaped database handle. */
export interface Database {
  prepare(query: string): PreparedStatement;
  batch?(statements: PreparedStatement[]): Promise<unknown[]>;
}

/** R2-shaped object metadata. */
export interface ObjectHead {
  size: number;
  etag?: string;
  uploaded?: Date;
  httpMetadata?: { contentType?: string };
}

/** R2-shaped object store (renders bucket + optional chat bucket alias). */
export interface ObjectStore {
  get(key: string): Promise<ArrayBuffer | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<void>;
  head(key: string): Promise<ObjectHead | null>;
  delete(key: string): Promise<void>;
  list?(prefix: string): Promise<{ keys: string[] }>;
}

/** Presigned URL minting for CPU containers and modules (r2-presign.ts parity). */
export interface ObjectPresigner {
  presignGet(key: string, expiresSec?: number): Promise<string>;
  presignPut(key: string, contentType: string, expiresSec?: number): Promise<string>;
}

export interface SecretStore {
  get(name: string): Promise<string | undefined>;
}

/** Service-binding-shaped module transport (registry.resolveFetcher parity). */
export interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface ModuleTransport {
  resolve(binding: string): FetcherLike | null;
  listBindings(): string[];
}

export interface RateLimitResult {
  success: boolean;
}

export interface RateLimiter {
  limit(key: string): Promise<RateLimitResult>;
}

export interface Scheduler {
  start(): void;
  stop(): void;
}

/** Aggregated platform surface passed into ported vivijure handlers. */
export interface Platform {
  db: Database;
  renders: ObjectStore;
  /** Chat-side bucket; may alias renders store locally. */
  chatBucket: ObjectStore;
  presigner: ObjectPresigner;
  secrets: SecretStore;
  modules: ModuleTransport;
  rateLimiter?: RateLimiter;
  scheduler?: Scheduler;
  /** Plain config vars (AUTH_MODE, spend knobs, etc.). */
  vars: Record<string, string | undefined>;
  /** Optional host-only service bindings (e.g. Node HTTP VPC shims). Merged into orchestrator context. */
  hostBindings?: Record<string, FetcherLike>;
}

/** Build a Record<string, unknown> env bag for code not yet ported off env-rec pattern. */
export function platformAsEnv(platform: Platform): Record<string, unknown> {
  const env: Record<string, unknown> = { ...platform.vars };
  env.DB = platform.db;
  env.R2_RENDERS = platform.renders;
  env.R2 = platform.chatBucket;
  for (const binding of platform.modules.listBindings()) {
    const fetcher = platform.modules.resolve(binding);
    if (fetcher) env[binding] = fetcher;
  }
  return env;
}
