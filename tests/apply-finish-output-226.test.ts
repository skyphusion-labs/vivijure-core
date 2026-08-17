import { describe, expect, it } from "vitest";
import {
  applyFinishOutput,
  applyFinishOutputOrRefuse,
  finishOutputIsCsamRefusal,
  isCsamRefusalReason,
  summarizeFinish,
} from "../src/film-model.js";
import type { FinishShot } from "../src/film-model.js";
import type { FinishOutput } from "../src/modules/types.js";
import { filmDonePayload } from "../src/render-output-payload.js";
import type { FilmJob } from "../src/film-model.js";

// core#226: applyFinishOutput used to swallow FinishOutput.degraded. The only degrade signal
// that survived was the `passthrough:` tag, so a wall-clock timeout and a no-face degrade
// were one literal. These tests pin the reason channel and the CSAM bright line.

function shot(over: Partial<FinishShot> = {}): FinishShot {
  return {
    shot_id: "s1",
    clip_key: "renders/p/clips/s1.mp4",
    chain: ["MODULE_LIPSYNC", "MODULE_UPSCALE"],
    configs: [{}, {}],
    idx: 0,
    status: "pending",
    applied: [],
    ...over,
  };
}

function out(over: Partial<FinishOutput> = {}): FinishOutput {
  return {
    shot_id: "s1",
    clip_key: "renders/p/clips/s1.mp4",
    out_fps: 24,
    frames: 96,
    applied: ["passthrough:backend-soft-degrade"],
    ...over,
  };
}

describe("applyFinishOutput persists FinishOutput.degraded (#226)", () => {
  it("copies the reason onto the shot instead of swallowing it", () => {
    const fs = shot();
    applyFinishOutput(fs, out({ degraded: "backend-soft-degrade: no detectable face in clip" }), "p");
    expect(fs.degraded).toEqual(["backend-soft-degrade: no detectable face in clip"]);
    expect(fs.applied).toEqual(["passthrough:backend-soft-degrade"]);
    expect(fs.idx).toBe(1);
    expect(fs.status).toBe("pending");
  });

  it("accumulates two step reasons, so last-write-wins cannot hide a cause", () => {
    const fs = shot();
    applyFinishOutput(fs, out({ degraded: "backend-soft-degrade: no detectable face in clip" }), "p");
    applyFinishOutput(fs, out({
      applied: ["passthrough:backend-soft-degrade"],
      degraded: "backend-soft-degrade: wall-clock guard expired after 900s",
    }), "p");
    expect(fs.degraded).toEqual([
      "backend-soft-degrade: no detectable face in clip",
      "backend-soft-degrade: wall-clock guard expired after 900s",
    ]);
    expect(fs.status).toBe("done");
    expect(summarizeFinish([fs]).reasons).toEqual([
      "backend-soft-degrade: no detectable face in clip",
      "backend-soft-degrade: wall-clock guard expired after 900s",
    ]);
  });

  it("does not invent a degraded list on a real success", () => {
    const fs = shot();
    applyFinishOutput(fs, out({ applied: ["lipsync:v15"], degraded: undefined }), "p");
    expect(fs.degraded).toBeUndefined();
    expect(fs.applied).toEqual(["lipsync:v15"]);
  });
});

describe("CSAM refusals stay a hard fail, never a degrade", () => {
  it("isCsamRefusalReason matches the house needle, case-insensitive", () => {
    expect(isCsamRefusalReason("csam detected")).toBe(true);
    expect(isCsamRefusalReason("CSAM child sexual content")).toBe(true);
    expect(isCsamRefusalReason("no detectable face in clip")).toBe(false);
    expect(isCsamRefusalReason("wall-clock guard expired after 900s")).toBe(false);
    expect(isCsamRefusalReason("")).toBe(false);
    expect(isCsamRefusalReason(undefined)).toBe(false);
  });

  it("a FinishOutput whose degraded or tag mentions csam is a refusal", () => {
    expect(finishOutputIsCsamRefusal(out({ degraded: "csam detected" }))).toBe(true);
    expect(finishOutputIsCsamRefusal(out({ applied: ["passthrough:csam"], degraded: undefined }))).toBe(true);
    expect(finishOutputIsCsamRefusal(out({ degraded: "no detectable face in clip" }))).toBe(false);
  });

  it("applyFinishOutputOrRefuse fails the shot and does not record a polish degrade", () => {
    const fs = shot();
    applyFinishOutputOrRefuse(fs, out({ degraded: "csam detected" }), "p");
    expect(fs.status).toBe("failed");
    expect(fs.error).toBe("csam detected");
    expect(fs.degraded).toBeUndefined();
    expect(fs.applied).toEqual([]);
    expect(fs.idx).toBe(0);
  });

  it("CONTROL: a no-face degrade still folds, so the refusal is a distinction", () => {
    const fs = shot();
    applyFinishOutputOrRefuse(fs, out({ degraded: "backend-soft-degrade: no detectable face in clip" }), "p");
    expect(fs.status).toBe("pending");
    expect(fs.degraded).toEqual(["backend-soft-degrade: no detectable face in clip"]);
    expect(fs.error).toBeUndefined();
  });

  it("applyFinishOutputOrRefuse fails the shot when clip_key escapes the project", () => {
    const fs = shot();
    applyFinishOutputOrRefuse(fs, out({ clip_key: "renders/other/clips/s1.mp4", degraded: undefined, applied: ["lipsync:v15"] }), "p");
    expect(fs.status).toBe("failed");
    expect(fs.clip_key).toBe("renders/p/clips/s1.mp4");
    expect(fs.error).toMatch(/refused key outside renders\/p\//);
    expect(fs.idx).toBe(0);
  });
});

describe("filmDonePayload carries clip-finish reasons the panel can show", () => {
  function job(over: Partial<FilmJob> = {}): FilmJob {
    return {
      film_id: "film-x",
      project: "p",
      bundle_key: "b",
      scenes: [],
      motion_backend: null,
      motion_config: {},
      finish_config: {},
      keyframe_binding: null,
      phase: "done",
      created_at: Date.now(),
      phase_started_at: Date.now(),
      ...over,
    } as FilmJob;
  }

  it("omits finish when the film never entered a finish chain", () => {
    const payload = filmDonePayload(job(), null);
    expect(payload.finish).toBeUndefined();
  });

  it("reports degraded:0 on a clean finish chain, so unmeasured stays distinguishable", () => {
    const payload = filmDonePayload(job({
      finish_shots: [shot({ status: "done", idx: 2, applied: ["lipsync:v15", "upscale:2x"] })],
    }), null);
    expect(payload.finish).toEqual({ degraded: 0, reasons: [] });
  });

  it("projects two distinct causes, not one passthrough: literal", () => {
    const payload = filmDonePayload(job({
      finish_shots: [
        shot({
          shot_id: "a",
          status: "done",
          idx: 2,
          applied: ["passthrough:backend-soft-degrade"],
          degraded: ["backend-soft-degrade: no detectable face in clip"],
        }),
        shot({
          shot_id: "b",
          status: "done",
          idx: 2,
          applied: ["passthrough:backend-soft-degrade"],
          degraded: ["backend-soft-degrade: wall-clock guard expired after 900s"],
        }),
      ],
    }), null);
    expect(payload.finish).toEqual({
      degraded: 2,
      reasons: [
        "backend-soft-degrade: no detectable face in clip",
        "backend-soft-degrade: wall-clock guard expired after 900s",
      ],
    });
  });
});
