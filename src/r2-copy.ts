// Copy one object inside a bucket, with its #583 hash sidecar.
//
// STREAMS ON A WORKER. On the R2 binding `get().body` is a ReadableStream that knows its length, so `put`
// accepts it and nothing is held in the isolate. A clip can be 256 MB (MAX_CLIP_BYTES in the video-finish
// door) and an isolate has 128 MB. Calling `arrayBuffer()` here would fail on exactly the clips worth
// reusing, which is why this does not. The Node host's `body` is bytes it already holds.

import type { R2Bucket } from "./platform/r2-types.js";

/**
 * Copy `src` to `dst`, then its `.hash` sidecar, last, so a sidecar only ever describes a whole clip.
 * False on any failure, with nothing left at `dst`, because a caller must not record a clip it does not
 * own. Never throws.
 */
export async function copyClipWithSidecar(bucket: R2Bucket, src: string, dst: string): Promise<boolean> {
  try {
    const sidecar = await bucket.get(`${src}.hash`);
    if (!sidecar) return false;
    const hash = await sidecar.text();
    const obj = await bucket.get(src);
    if (!obj) return false;
    await bucket.put(dst, obj.body, { httpMetadata: { contentType: "video/mp4" } });
    const [from, to] = await Promise.all([bucket.head(src), bucket.head(dst)]);
    if (!from || !to || from.size !== to.size) throw new Error(`copy of ${src} is not whole`);
    await bucket.put(`${dst}.hash`, hash, { httpMetadata: { contentType: "text/plain" } });
    return true;
  } catch (e) {
    console.warn(`clip copy ${src} -> ${dst} failed: ${(e as Error).message}`);
    await bucket.delete(dst).catch(() => undefined);
    await bucket.delete(`${dst}.hash`).catch(() => undefined);
    return false;
  }
}
