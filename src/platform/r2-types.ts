// R2-shaped bucket API (Workers compatibility layer over ObjectStore).

import type { ObjectHead } from "./types.js";

export interface R2ObjectBody {
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body: Uint8Array;
}

export interface R2ListedObject {
  key: string;
  uploaded: Date;
}

export interface R2ListResult {
  objects: R2ListedObject[];
  truncated: boolean;
  cursor?: string;
}

export interface R2GetOptions {
  range?: { offset: number; length: number };
}

export interface R2Bucket {
  get(key: string, opts?: R2GetOptions): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: string | Uint8Array | ArrayBuffer | R2ObjectBody,
    opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<void>;
  head(key: string): Promise<(ObjectHead & { etag?: string }) | null>;
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<R2ListResult>;
  delete(key: string): Promise<void>;
}
