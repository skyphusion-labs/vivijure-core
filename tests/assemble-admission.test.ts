import { describe, it, expect } from "vitest";
import {
  admitAssemble,
  assembleFilmByteCeiling,
  predictNormalizedBytes,
  resolveAssembleSeconds,
  CONTAINER_DEFAULT_FPS,
  CONTAINER_DISK_BYTES,
  NORMALIZED_BITS_PER_PIXEL_FRAME,
  FINALIZE_FILM_COPIES,
} from "../src/assemble-admission.js";
import { DEFAULT_DELIVERY_FPS } from "../src/film-model.js";

// cf#815: the pre-flight input-bytes admission check.
//
// THE POINT OF THIS SUITE IS THAT THE GATE HAS A REACHABLE FAILING WORLD **AND** A REACHABLE
// PASSING ONE. cf#815 rules that a refusal-only gate is as broken as one that never refuses, and
// cf#813 measures why the obvious threshold (`MAX_CLIPS x MAX_CLIP_BYTES`) could only ever produce
// the second kind: 23x-120x above what a real film weighs. So every claim below is asserted in
// BOTH directions, and the boundary is asserted from both sides of one second.

// The container's own constants, quoted so the tests can prove the gate fires on input the
// container would otherwise accept. containers/video-finish/app.py:40 and :45.
const MAX_CLIPS = 80;
const MAX_CLIP_BYTES = 256 * 1024 * 1024;

const HD = { width: 1920, height: 1080 };
const mbps = (bytesPerSecond: number) => (bytesPerSecond * 8) / 1_000_000;

/** Every clip measured, all the same length. */
function evenFilm(clips: number, seconds: number) {
  return {
    clipCount: clips,
    ...HD,
    fps: DEFAULT_DELIVERY_FPS,
    basis: { seconds: clips * seconds, measured: clips, planned: 0, unknown: 0 },
  };
}

describe("cf#815 the three fps numbers agree, mechanically", () => {
  it("CONTAINER_DEFAULT_FPS equals core's DEFAULT_DELIVERY_FPS", () => {
    // A prediction at the wrong frame rate is wrong by exactly their ratio. This is the mechanism
    // that stops the comment in assemble-admission.ts from being the only thing holding them level.
    expect(CONTAINER_DEFAULT_FPS).toBe(DEFAULT_DELIVERY_FPS);
  });
});

describe("cf#815 the bitrate constant is cf#813's MEASUREMENT, not a guess", () => {
  // cf#813 measured, through this container's exact normalize command:
  //   1080p24 crf18 medium -> band tops out at 11.16 Mbps
  //    720p24 crf18 medium -> band tops out at  4.82 Mbps
  // The constant is derived from the first. The second is an INDEPENDENT row, so reproducing it is
  // a real cross-check rather than restating the input.
  it("reproduces the measured 1080p24 ceiling, from above (never under-predicting)", () => {
    const r = mbps(predictNormalizedBytes(1920, 1080, 24, 1)) / 11.16;
    expect(r).toBeGreaterThanOrEqual(1.0);
    expect(r).toBeLessThan(1.01);
  });

  it("reproduces the measured 720p24 ceiling it was NOT fitted to, also from above", () => {
    const r = mbps(predictNormalizedBytes(1280, 720, 24, 1)) / 4.82;
    expect(r).toBeGreaterThanOrEqual(1.0);
    expect(r).toBeLessThan(1.06);
  });

  it("over-prediction is the deliberate direction: a refusal is early, never late", () => {
    // If this constant is ever tuned DOWN to the middle of cf#813's band the gate refuses later,
    // which is the direction that ends in ENOSPC. Pin the intent.
    expect(NORMALIZED_BITS_PER_PIXEL_FRAME).toBeGreaterThanOrEqual(11.16e6 / (1920 * 1080 * 24));
  });
});

describe("cf#815 the threshold is NOT MAX_CLIPS x MAX_CLIP_BYTES", () => {
  it("the ceiling is well under that product, and under the raw disk", () => {
    // The product is 20.0 GB, i.e. the whole disk. A gate at the disk size cannot fire before the
    // disk is full, which is the defect cf#813 named.
    expect(MAX_CLIPS * MAX_CLIP_BYTES).toBeGreaterThan(CONTAINER_DISK_BYTES * 0.99);
    expect(assembleFilmByteCeiling()).toBeLessThan(CONTAINER_DISK_BYTES / 2);
  });

  it("the ceiling reserves for BOTH full-length copies resident at finalize", () => {
    // _silent.mp4 then final.mp4, with no remove between them. If FINALIZE_FILM_COPIES ever drops
    // to 1 the ceiling doubles, so the multiplier is asserted rather than assumed.
    expect(FINALIZE_FILM_COPIES).toBe(2);
    expect(assembleFilmByteCeiling() * FINALIZE_FILM_COPIES).toBeLessThan(CONTAINER_DISK_BYTES);
  });
});

describe("cf#815 the gate FIRES, on input the container's own guards admit", () => {
  it("a film of MAX_CLIPS long clips is refused, and every clip passes the download guard", () => {
    // 62s per clip. cf#813 measures generated video down to 0.40 Mbps at the low end of the band,
    // and even at a generous 8 Mbps source a 62s clip is 62 MB -- a quarter of MAX_CLIP_BYTES. So
    // the container would accept every single clip and only discover the problem on the disk.
    const perClipSourceBytesAt8Mbps = (8e6 / 8) * 62;
    expect(perClipSourceBytesAt8Mbps).toBeLessThan(MAX_CLIP_BYTES);

    const r = admitAssemble(evenFilm(MAX_CLIPS, 62));
    expect(r.admitted).toBe(false);
    expect(r.predictedBytes).toBeGreaterThan(r.ceilingBytes);
  });

  it("a clearly over-size film is refused with the arithmetic in the message", () => {
    const r = admitAssemble(evenFilm(MAX_CLIPS, 120));
    expect(r.admitted).toBe(false);
    const reason = r.reason ?? "";
    expect(reason).toContain("assemble refused before any clip was fetched");
    expect(reason).toContain("80 clip(s)");
    expect(reason).toContain("9600.0s");          // what was asked
    expect(reason).toContain("1920x1080@24");     // at what target
    expect(reason).toMatch(/Over by \d+\.\d\d GB/); // by how much
    expect(reason).toContain("admits at most");   // what WOULD be accepted
    expect(reason).toContain("80 measured, 0 planned, 0 unknown");
  });

  it("the refusal names a length that is actually admissible", () => {
    // The actionable number has to be true, or the caller retries into a second refusal.
    const r = admitAssemble(evenFilm(MAX_CLIPS, 120));
    const retry = admitAssemble({
      clipCount: MAX_CLIPS,
      ...HD,
      fps: DEFAULT_DELIVERY_FPS,
      basis: { seconds: r.allowedSeconds, measured: MAX_CLIPS, planned: 0, unknown: 0 },
    });
    expect(retry.admitted).toBe(true);
  });
});

describe("cf#815 CONTROL: a legitimate large film is still admitted", () => {
  it("MAX_CLIPS clips at the contract's 8.0s clipSeconds is admitted with room to spare", () => {
    // cf#813 measures a full 80-clip film at roughly 750 MB. This is the largest film the clip
    // path can legitimately produce, and it must pass, or the gate is just set to zero.
    const r = admitAssemble(evenFilm(MAX_CLIPS, 8));
    expect(r.admitted).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.predictedBytes).toBeLessThan(r.ceilingBytes / 5); // 7x margin, not a squeeze
  });

  it("a long-but-plausible feature at 1080p is admitted", () => {
    const r = admitAssemble(evenFilm(MAX_CLIPS, 30)); // 40 minutes
    expect(r.admitted).toBe(true);
  });

  it("the same film is admitted at a LOWER delivery target after being refused at 1080p", () => {
    const tooBig = { clipCount: 60, ...HD, fps: 24, basis: { seconds: 6000, measured: 60, planned: 0, unknown: 0 } };
    expect(admitAssemble(tooBig).admitted).toBe(false);
    expect(admitAssemble({ ...tooBig, width: 1280, height: 720 }).admitted).toBe(true);
  });
});

describe("cf#815 the boundary is real from both sides of one second", () => {
  it("allowedSeconds admits and allowedSeconds+1 refuses", () => {
    const at = admitAssemble(evenFilm(10, 1)); // any film; read the ceiling off it
    const edge = at.allowedSeconds;
    expect(edge).toBeGreaterThan(0);
    const under = admitAssemble({ clipCount: 10, ...HD, fps: 24, basis: { seconds: edge, measured: 10, planned: 0, unknown: 0 } });
    const over = admitAssemble({ clipCount: 10, ...HD, fps: 24, basis: { seconds: edge + 1, measured: 10, planned: 0, unknown: 0 } });
    expect(under.admitted).toBe(true);
    expect(over.admitted).toBe(false);
  });
});

describe("cf#815 the basis is EVIDENCE, and absence is named not invented", () => {
  const clips = [{ shot_id: "a" }, { shot_id: "b" }, { shot_id: "c" }];

  it("a measured duration beats the plan for the same shot", () => {
    const b = resolveAssembleSeconds(clips, new Map([["a", 12]]), { a: 4, b: 4, c: 4 });
    expect(b.seconds).toBe(20); // 12 measured + 4 + 4 planned, NOT 12 (4 planned for a)
    expect(b.measured).toBe(1);
    expect(b.planned).toBe(2);
    expect(b.unknown).toBe(0);
  });

  it("a shot with neither contributes ZERO and is counted, never defaulted", () => {
    const b = resolveAssembleSeconds(clips, new Map([["a", 10]]), {});
    expect(b.seconds).toBe(10);
    expect(b.unknown).toBe(2);
  });

  it("a non-positive or non-finite measurement falls through to the plan", () => {
    const b = resolveAssembleSeconds([{ shot_id: "a" }], new Map([["a", 0]]), { a: 7 });
    expect(b.seconds).toBe(7);
    expect(b.measured).toBe(0);
    expect(b.planned).toBe(1);
  });

  it("an all-unknown film is ADMITTED, never refused on absence", () => {
    // Mirrors the #697 duration gate's discipline: the check fires on evidence. A film whose
    // durations are simply unavailable must not be failed by the guard meant to protect it.
    const r = admitAssemble({ clipCount: 3, ...HD, fps: 24, basis: resolveAssembleSeconds(clips, new Map(), {}) });
    expect(r.admitted).toBe(true);
    expect(r.basis.unknown).toBe(3);
  });

  it("a refusal built on a partial basis SAYS it is a lower bound", () => {
    // Honest: the clips we could size already blow the disk, so the answer is sound; but the
    // message must not imply the number is the whole film.
    const b = { seconds: 9600, measured: 70, planned: 0, unknown: 10 };
    const r = admitAssemble({ clipCount: 80, ...HD, fps: 24, basis: b });
    expect(r.admitted).toBe(false);
    expect(r.reason).toContain("LOWER bound");
    expect(r.reason).toContain("10 clip(s) of unknown length contributed 0s");
  });

  it("a complete basis does NOT claim to be a lower bound", () => {
    const r = admitAssemble(evenFilm(80, 120));
    expect(r.reason).not.toContain("LOWER bound");
  });
});

describe("cf#815 degenerate input cannot fabricate a prediction", () => {
  it("zero or negative dimensions predict zero rather than NaN", () => {
    expect(predictNormalizedBytes(0, 1080, 24, 10)).toBe(0);
    expect(predictNormalizedBytes(1920, 1080, 24, -1)).toBe(0);
    expect(predictNormalizedBytes(1920, 1080, 0, 10)).toBe(0);
  });

  it("an fps of 0 falls back to the container default rather than predicting nothing", () => {
    const r = admitAssemble({ clipCount: 80, ...HD, fps: 0, basis: { seconds: 9600, measured: 80, planned: 0, unknown: 0 } });
    expect(r.admitted).toBe(false);
    expect(r.reason).toContain("@" + CONTAINER_DEFAULT_FPS);
  });
});
