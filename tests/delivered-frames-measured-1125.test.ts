import { describe, expect, it, vi } from "vitest";
import { applyMeasuredFrames, validateDoneClips, type ClipJob, type ClipShot } from "../src/render-orchestrator.js";
import { clipDeliveries } from "../src/film-model.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#1125. Measured 2026-10-30 on film-8fd307b1 and film-63ffdc03: `cf-hailuo` reported 144 frames
// (`seconds * OUT_FPS`) and ffprobe read 141 at 5.875 s of video. So `delivered` was the plan.

function mp4(frames: number, seconds: number, width = 1344, height = 768): Uint8Array {
  const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const mvhd = new Uint8Array(100);
  new DataView(mvhd.buffer).setUint32(12, 1000);
  new DataView(mvhd.buffer).setUint32(16, Math.round(seconds * 1000));
  const tkhd = new Uint8Array(84);
  new DataView(tkhd.buffer).setUint32(76, width * 65536);
  new DataView(tkhd.buffer).setUint32(80, height * 65536);
  const hdlr = new Uint8Array(24);
  hdlr.set([0x76, 0x69, 0x64, 0x65], 8);
  const stsz = new Uint8Array(12);
  new DataView(stsz.buffer).setUint32(8, frames);
  const moov = box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd), box("mdia", box("hdlr", hdlr), box("minf", box("stbl", box("stsz", stsz))))));
  const ftyp = box("ftyp", new Uint8Array(8));
  const pad = box("free", new Uint8Array(4096));
  const out = new Uint8Array(ftyp.length + moov.length + pad.length);
  out.set(ftyp, 0); out.set(moov, ftyp.length); out.set(pad, ftyp.length + moov.length);
  return out;
}
const envFor = (bytes: Uint8Array | null) => ({
  R2_RENDERS: {
    head: async () => (bytes ? { size: bytes.length } : null),
    get: async (_k: string, o?: { range?: { offset: number; length: number } }) => {
      if (!bytes) return null;
      const off = o?.range?.offset ?? 0;
      const s = bytes.slice(off, off + (o?.range?.length ?? bytes.length));
      return { arrayBuffer: async () => s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) };
    },
  },
}) as unknown as Env;
const shot = (over: Partial<ClipShot> = {}) => ({ shot_id: "s1", status: "done", clip_key: "renders/p/clips/s1.mp4", seconds: 6, delivered_fps: 24, delivered_frames: 144, ...over }) as ClipShot;
const job = (s: ClipShot) => ({ job_id: "c", project: "p", shots: [s] }) as unknown as ClipJob;

describe("validateDoneClips records the measured frames", () => {
  it("the measured case: a door that reported 144 reads 141", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const j = job(shot());
    await validateDoneClips(envFor(mp4(141, 5.875)), j);
    expect(j.shots[0]).toMatchObject({ delivered_frames: 141, delivered_fps: 24, delivered_measured: true });
    expect(clipDeliveries(j)![0]).toEqual({ shot_id: "s1", planned_seconds: 6, delivered_seconds: 5.875, fps: 24, frames: 141, measured: true });
  });

  it("an unreadable clip keeps the report and does not claim to be measured", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const j = job(shot());
    await validateDoneClips(envFor(null), j);
    expect(j.shots[0]).toMatchObject({ delivered_frames: 144 });
    expect(clipDeliveries(j)![0].measured).toBeUndefined();
  });

  it("a door with nothing to report now has a real delivery", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const j = job(shot({ delivered_fps: undefined, delivered_frames: undefined }));
    await validateDoneClips(envFor(mp4(96, 4)), j);
    expect(clipDeliveries(j)![0]).toMatchObject({ frames: 96, fps: 24, delivered_seconds: 4, measured: true });
  });
});

describe("applyMeasuredFrames", () => {
  it("keeps the door's rate when an audio track makes the file a little longer", () => {
    const s = shot({ delivered_frames: 96 });
    applyMeasuredFrames(s, 97, 4.064);
    expect(s).toMatchObject({ delivered_frames: 97, delivered_fps: 24 });
  });
  it("does not believe a rate the file contradicts", () => {
    const s = shot({ delivered_frames: 120, delivered_fps: 24 });
    applyMeasuredFrames(s, 120, 4);
    expect(s).toMatchObject({ delivered_frames: 120, delivered_fps: 30 });
  });
  it("no frame count is no change", () => {
    const s = shot();
    expect(applyMeasuredFrames(s, null, 5.875)).toBe(false);
    expect(applyMeasuredFrames(s, 0, 5.875)).toBe(false);
    expect(applyMeasuredFrames(s, 0, null)).toBe(false);
    expect(s).toMatchObject({ delivered_frames: 144 });
    expect(s.delivered_measured).toBeUndefined();
  });
  it("frames with no duration and no report cannot name a rate, so nothing changes", () => {
    const s = shot({ delivered_fps: undefined, delivered_frames: undefined });
    expect(applyMeasuredFrames(s, 96, null)).toBe(false);
    expect(s.delivered_frames).toBeUndefined();
  });
  it("frames with no duration keep the reported rate", () => {
    const s = shot();
    expect(applyMeasuredFrames(s, 141, null)).toBe(true);
    expect(s).toMatchObject({ delivered_frames: 141, delivered_fps: 24 });
  });
  it("a second pass with the same numbers is not a change", () => {
    const s = shot();
    applyMeasuredFrames(s, 141, 5.875);
    expect(applyMeasuredFrames(s, 141, 5.875)).toBe(false);
  });
});
