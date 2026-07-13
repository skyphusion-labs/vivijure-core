import { describe, expect, it } from "vitest";
import { validateClipArtifact, MOOV_FETCH_CAP, CLIP_MIN_BYTES } from "../src/clip-validate.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// #25: a header-only / degenerate moov (payloadLen <= 0) must NOT be trusted as a valid video track.
// The old blanket `else` set video_track = true for BOTH "too large to introspect" (intentional trust) and
// "empty/header-only" (corrupt), so an ftyp + size-8 moov + noise mdat passed the shape gate with the
// zero-frame / no-track protections silently bypassed. Build synthetic mp4s over a fake ranged R2 and
// assert the split: payloadLen <= 0 -> fail; payloadLen > MOOV_FETCH_CAP -> still trusted (pass).

/** ftyp(16) + a single moov box whose 32-bit size field is `moovSize`; padded to `totalBytes`. */
function craftMp4(moovSize: number, totalBytes: number): Env {
  const buf = new Uint8Array(Math.max(totalBytes, 24));
  const write = (o: number, size: number, type: string) => {
    buf[o] = (size >>> 24) & 0xff;
    buf[o + 1] = (size >>> 16) & 0xff;
    buf[o + 2] = (size >>> 8) & 0xff;
    buf[o + 3] = size & 0xff;
    for (let i = 0; i < 4; i++) buf[o + 4 + i] = type.charCodeAt(i);
  };
  write(0, 16, "ftyp"); // ftyp header + 8 bytes brand (zeros)
  write(16, moovSize, "moov"); // moov header only; payload (if any) is never present, mirrors a degenerate box
  const R2_RENDERS = {
    head: async () => ({ size: totalBytes }),
    get: async (_key: string, opts?: { range?: { offset: number; length: number } }) => {
      const off = opts?.range?.offset ?? 0;
      const len = opts?.range?.length ?? buf.length - off;
      const slice = buf.slice(off, off + len);
      return { arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
    },
  };
  return { R2_RENDERS } as unknown as Env;
}

describe("validateClipArtifact -- degenerate moov gate (#25)", () => {
  it("FAILS a header-only moov (size === headerSize, payloadLen 0) -- no video track trusted", async () => {
    const env = craftMp4(8, CLIP_MIN_BYTES + 512); // moov size 8 == 8-byte header -> payloadLen 0
    const res = await validateClipArtifact(env, "renders/p/clips/shot_01_i2v.mp4", 4);
    expect(res.verdict).toBe("fail");
    expect(res.checks.container).toBe(true); // ftyp+moov present...
    expect(res.checks.video_track).toBe(false); // ...but the empty moov is NOT a trustworthy track
    expect(res.reason).toMatch(/no video track/i);
  });

  it("still TRUSTS a moov too large to introspect (payloadLen > MOOV_FETCH_CAP) -- pass", async () => {
    // moov claims a payload larger than the fetch cap: intentional -- trust the container, skip deep checks.
    const env = craftMp4(MOOV_FETCH_CAP + 100, CLIP_MIN_BYTES + 512);
    const res = await validateClipArtifact(env, "renders/p/clips/shot_01_i2v.mp4", 4);
    expect(res.verdict).toBe("pass");
    expect(res.checks.video_track).toBe(true);
  });
});
