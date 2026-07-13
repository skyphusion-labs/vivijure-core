// R2-shaped bucket API over platform ObjectStore (Workers R2 compatibility layer).

import type { ObjectStore } from "./types.js";
import type { R2Bucket, R2GetOptions, R2ListedObject, R2ListResult, R2ObjectBody } from "./r2-types.js";

/** First index in a lexicographically-sorted array whose element is strictly greater than `cursor`. */
function firstIndexAfter(sortedKeys: string[], cursor: string): number {
  let lo = 0;
  let hi = sortedKeys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedKeys[mid] > cursor) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

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
    opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<void> {
    let payload: ArrayBuffer | Uint8Array | string;
    if (typeof value === "object" && value !== null && "body" in value) {
      payload = value.body;
    } else {
      payload = value;
    }
    // customMetadata is R2-only hygiene; ObjectStore adapters may ignore it.
    await this.store.put(key, payload, opts ? { httpMetadata: opts.httpMetadata } : undefined);
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
    // #22: paginate over a lexicographically-sorted key set with a KEY-based cursor (the last key of the
    // page), matching real R2/S3 semantics. The prior scheme used a numeric OFFSET into a list refetched
    // on every page, so a concurrent insert/delete lexically before the offset shifted every later key by
    // one -- the next page then re-read an already-seen key (dup) or stepped over an unread one (skip). A
    // key cursor returns only keys strictly greater than it, so mutations behind the cursor cannot shift
    // what is still to come. (.slice() first: never mutate the array the store handed back.)
    const raw = await this.store.list(opts.prefix);
    // #20: when the host returns per-object metadata inline (e.g. S3 ListObjectsV2 already carries
    // LastModified), index it so we skip the HEAD-per-key round-trip storm below. A host that returns only
    // `keys` leaves `inline` undefined and we fall back to a HEAD per key.
    const inline = raw.objects ? new Map(raw.objects.map((o) => [o.key, o])) : undefined;
    const keys = raw.keys.slice().sort();
    const limit = opts.limit ?? 1000;
    const startIdx = opts.cursor ? firstIndexAfter(keys, opts.cursor) : 0;
    const slice = keys.slice(startIdx, startIdx + limit);
    const objects: R2ListedObject[] = [];
    for (const key of slice) {
      // #19: propagate `uploaded` HONESTLY (it is ICD-optional on ObjectHead). The prior `?? new Date(0)`
      // fabricated a 1970 timestamp for a host that omits uploaded; the freshness-floor reclaim (#661)
      // reads that as "older than any floor" -> excludes every object -> reclaim silently dead, with no way
      // for a consumer to tell "unknown upload time" from "genuinely ancient". Leave it undefined and let
      // the consumer choose its own safe branch (see listClipsByShotId in render-orchestrator.ts).
      const uploaded = inline ? inline.get(key)?.uploaded : (await this.store.head(key))?.uploaded;
      objects.push({ key, uploaded });
    }
    const truncated = startIdx + slice.length < keys.length;
    return {
      objects,
      truncated,
      cursor: truncated && slice.length ? slice[slice.length - 1] : undefined,
    };
  }
}

export function wrapR2Bucket(store: ObjectStore): R2Bucket {
  return new ObjectStoreR2Bucket(store as StoreWithRange);
}
