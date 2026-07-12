// R2-shaped bucket API over platform ObjectStore (Workers R2 compatibility layer).

import type { ObjectStore } from "./types.js";
import type { R2Bucket, R2GetOptions, R2ListResult, R2ObjectBody } from "./r2-types.js";

function toBody(bytes: Uint8Array): R2ObjectBody {
  return {
    body: bytes,
    async text() {
      return new TextDecoder().decode(bytes);
    },
    async json<T>() {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
}

type StoreWithRange = ObjectStore & {
  getRange?(key: string, offset: number, length: number): Promise<Uint8Array | null>;
};

export class ObjectStoreR2Bucket implements R2Bucket {
  constructor(private readonly store: StoreWithRange) {}

  async get(key: string, opts?: R2GetOptions): Promise<R2ObjectBody | null> {
    if (opts?.range && this.store.getRange) {
      const slice = await this.store.getRange(key, opts.range.offset, opts.range.length);
      if (!slice) return null;
      return toBody(slice);
    }
    const buf = await this.store.get(key);
    if (!buf) return null;
    return toBody(new Uint8Array(buf));
  }

  async put(
    key: string,
    value: string | Uint8Array | ArrayBuffer | R2ObjectBody,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    let payload: ArrayBuffer | Uint8Array | string;
    if (typeof value === "object" && value !== null && "body" in value) {
      payload = value.body;
    } else {
      payload = value;
    }
    await this.store.put(key, payload, opts);
  }

  async head(key: string) {
    return this.store.head(key);
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key);
  }

  async list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<R2ListResult> {
    if (!this.store.list) {
      return { objects: [], truncated: false };
    }
    const keys = (await this.store.list(opts.prefix)).keys;
    const start = opts.cursor ? Number(opts.cursor) || 0 : 0;
    const limit = opts.limit ?? 1000;
    const slice = keys.slice(start, start + limit);
    const objects = [];
    for (const key of slice) {
      const h = await this.store.head(key);
      objects.push({ key, uploaded: h?.uploaded ?? new Date(0) });
    }
    const truncated = start + limit < keys.length;
    return {
      objects,
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }
}

export function wrapR2Bucket(store: ObjectStore): R2Bucket {
  return new ObjectStoreR2Bucket(store as StoreWithRange);
}
