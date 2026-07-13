import { describe, expect, it } from "vitest";
import { wrapR2Bucket } from "../src/platform/object-store-r2.js";
import type { ObjectHead, ObjectStore } from "../src/platform/types.js";

// #22 + #19: the R2-compat list() adapter over a host ObjectStore. These exercise the two host-neutrality
// bugs on the emulated-list path (CF prod uses native R2, unaffected):
//   #22 -- numeric-offset-into-a-refetched-list pagination skipped/duped keys under concurrent writes.
//   #19 -- a missing ObjectHead.uploaded was fabricated as new Date(0), silently killing freshness-floor
//          reclaim on any host that omits the ICD-optional field.

/** Mutable in-memory store. `uploadedFor` decides each key's head.uploaded (undefined => host omits it). */
function fakeStore(
  initial: string[],
  uploadedFor: (key: string) => Date | undefined = () => new Date(1000),
): ObjectStore & { add(key: string): void; remove(key: string): void } {
  const keys = new Set(initial);
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    async head(key): Promise<ObjectHead | null> {
      if (!keys.has(key)) return null;
      return { size: 1, uploaded: uploadedFor(key) };
    },
    async list(prefix: string) {
      // Return in INSERTION-ish (Set) order, deliberately NOT sorted, to prove the adapter sorts.
      return { keys: [...keys].filter((k) => k.startsWith(prefix)) };
    },
    add(key: string) {
      keys.add(key);
    },
    remove(key: string) {
      keys.delete(key);
    },
  };
}

async function drain(
  bucket: ReturnType<typeof wrapR2Bucket>,
  prefix: string,
  limit: number,
  mutate?: (page: number) => void,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  let page = 0;
  do {
    const res = await bucket.list({ prefix, cursor, limit });
    for (const o of res.objects) out.push(o.key);
    cursor = res.truncated ? res.cursor : undefined;
    mutate?.(++page);
  } while (cursor);
  return out;
}

describe("ObjectStoreR2Bucket.list host-neutrality", () => {
  it("#22: a key inserted behind the cursor mid-drain causes no dup and no skip", async () => {
    const store = fakeStore(["p/k00", "p/k01", "p/k02", "p/k03", "p/k04"]);
    const bucket = wrapR2Bucket(store);

    // After page 1 (cursor at p/k01), insert a key that sorts BEFORE the cursor. A numeric-offset cursor
    // ("2") would now point one slot late -> page 2 re-reads p/k01 (dup) and steps over a later key.
    const seen = await drain(bucket, "p/", 2, (pageJustFinished) => {
      if (pageJustFinished === 1) store.add("p/a_inserted");
    });

    // No duplicates.
    expect(new Set(seen).size).toBe(seen.length);
    // Every original key still surfaced (nothing skipped). a_inserted sorts before the cursor so it is
    // legitimately not revisited -- that is correct S3-style snapshot pagination, not a skip of live work.
    for (const k of ["p/k00", "p/k01", "p/k02", "p/k03", "p/k04"]) {
      expect(seen).toContain(k);
    }
  });

  it("#22: pagination returns the full set in sorted order across pages", async () => {
    const store = fakeStore(["p/k03", "p/k00", "p/k04", "p/k01", "p/k02"]);
    const seen = await drain(wrapR2Bucket(store), "p/", 2);
    expect(seen).toEqual(["p/k00", "p/k01", "p/k02", "p/k03", "p/k04"]);
  });

  it("#22: cursor is the last KEY of the page, not a numeric offset", async () => {
    const store = fakeStore(["p/k00", "p/k01", "p/k02"]);
    const res = await wrapR2Bucket(store).list({ prefix: "p/", limit: 2 });
    expect(res.truncated).toBe(true);
    expect(res.cursor).toBe("p/k01");
  });

  it("#19: a host that omits uploaded yields undefined, NOT a fabricated epoch", async () => {
    const store = fakeStore(["p/k00"], () => undefined);
    const res = await wrapR2Bucket(store).list({ prefix: "p/" });
    expect(res.objects).toHaveLength(1);
    expect(res.objects[0].uploaded).toBeUndefined();
  });

  it("#19: a host that provides uploaded passes the real Date through", async () => {
    const when = new Date(1_700_000_000_000);
    const store = fakeStore(["p/k00"], () => when);
    const res = await wrapR2Bucket(store).list({ prefix: "p/" });
    expect(res.objects[0].uploaded).toEqual(when);
  });

  it("#20: inline list metadata is used and NO per-key HEAD is issued", async () => {
    const when = new Date(1_700_000_000_000);
    const inlineKeys = ["p/k00", "p/k01", "p/k02"];
    let heads = 0;
    const store: ObjectStore = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      async head() {
        heads++;
        return { size: 1, uploaded: when };
      },
      // Host returns per-object metadata inline (the S3-LastModified fast path).
      async list(prefix) {
        const keys = inlineKeys.filter((k) => k.startsWith(prefix));
        return { keys, objects: keys.map((key) => ({ key, uploaded: when })) };
      },
    };
    const res = await wrapR2Bucket(store).list({ prefix: "p/" });
    expect(res.objects.map((o) => o.key)).toEqual(inlineKeys);
    expect(res.objects.every((o) => o.uploaded?.getTime() === when.getTime())).toBe(true);
    expect(heads).toBe(0); // the whole point of #20: no HEAD storm
  });

  it("#20: a host that returns only keys still works (HEAD fallback)", async () => {
    let heads = 0;
    const store: ObjectStore = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      async head() {
        heads++;
        return { size: 1, uploaded: new Date(5000) };
      },
      async list(prefix) {
        return { keys: ["p/k00", "p/k01"].filter((k) => k.startsWith(prefix)) };
      },
    };
    const res = await wrapR2Bucket(store).list({ prefix: "p/" });
    expect(res.objects).toHaveLength(2);
    expect(heads).toBe(2); // no inline metadata -> HEAD per key
  });
});
