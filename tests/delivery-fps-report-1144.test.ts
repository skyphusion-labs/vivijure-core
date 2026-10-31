import { describe, expect, it } from "vitest";
import { resolveFilmFrame, type FilmJob } from "../src/film-orchestrator.js";
import { clipJobDocKey, summarizeFinish } from "../src/film-model.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#1144, measured on film-f70f2700: shot_01_finished.mp4 is 48 fps with 281 frames, the
// final film is 24 fps, and the poll said degraded: 0.

/** A real box tree with an stsz sample count, so the production parser reads frames and duration. */
function mp4(frames: number, seconds = 6): Uint8Array {
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
  new DataView(mvhd.buffer).setUint32(16, seconds * 1000);
  const tkhd = new Uint8Array(84);
  new DataView(tkhd.buffer).setUint32(76, 1344 * 65536);
  new DataView(tkhd.buffer).setUint32(80, 768 * 65536);
  const hdlr = new Uint8Array(24);
  hdlr.set([0x76, 0x69, 0x64, 0x65], 8);
  const stsz = new Uint8Array(12);
  new DataView(stsz.buffer).setUint32(4, 1000);
  new DataView(stsz.buffer).setUint32(8, frames);
  const mdia = box("mdia", box("hdlr", hdlr), box("minf", box("stbl", box("stsz", stsz))));
  const moov = box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd), mdia));
  const ftyp = box("ftyp", new Uint8Array(8));
  const pad = box("free", new Uint8Array(4096));
  const out = new Uint8Array(ftyp.length + moov.length + pad.length);
  out.set(ftyp, 0); out.set(moov, ftyp.length); out.set(pad, ftyp.length + moov.length);
  return out;
}

const KEY = "renders/p/clips/s1_finished.mp4";
const DOC = clipJobDocKey("c");

function env(clip: Uint8Array) {
  const doc = JSON.stringify({ job_id: "c", shots: [{ shot_id: "s1", status: "done", delivered_width: 1344, delivered_height: 768, delivered_frames: 144, delivered_fps: 24 }] });
  return {
    R2_RENDERS: {
      head: async (k: string) => (k === KEY ? { size: clip.length } : k === DOC ? { size: 1 } : null),
      get: async (k: string, opts?: { range?: { offset: number; length: number } }) => {
        if (k === KEY) {
          const off = opts?.range?.offset ?? 0;
          const slice = clip.slice(off, off + (opts?.range?.length ?? clip.length));
          return { arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
        }
        return k === DOC ? { text: async () => doc } : null;
      },
    },
  } as unknown as Env;
}

const job = (over: Partial<FilmJob> = {}): FilmJob => ({
  film_id: "film-1", project: "p", phase: "assemble", created_at: 1, scenes: [], bundle_key: "b", clip_job_id: "c",
  finish_shots: [{ shot_id: "s1", clip_key: KEY, chain: ["MODULE_R"], configs: [{}], idx: 1, status: "done", applied: ["interpolate:2x"] }],
  ...over,
}) as unknown as FilmJob;

describe("the finish summary reports a clip above the delivery rate", () => {
  it("names a 48 fps clip delivered at 24 fps (the measured case)", async () => {
    const j = job();
    await resolveFilmFrame(env(mp4(288)), j);
    const s = summarizeFinish(j.finish_shots!);
    expect(s.degraded).toBe(1);
    expect(s.reasons).toContain("finished clip is 48 fps, delivered at 24 fps");
  });

  it("CONTROL: a clip at the delivery rate reports nothing", async () => {
    const j = job();
    await resolveFilmFrame(env(mp4(144)), j);
    expect(summarizeFinish(j.finish_shots!).degraded).toBe(0);
  });

  it("does not report a clip that rounds to the rate", async () => {
    const j = job();
    await resolveFilmFrame(env(mp4(149)), j);
    expect(summarizeFinish(j.finish_shots!).degraded).toBe(0);
  });

  it("an operator rate at or above the clip reports nothing", async () => {
    const j = job({ delivery_fps: 48 });
    await resolveFilmFrame(env(mp4(288)), j);
    expect(summarizeFinish(j.finish_shots!).degraded).toBe(0);
  });
});
