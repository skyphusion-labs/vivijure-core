import { describe, expect, it } from "vitest";
import {
  contentValidateDoneClips,
  contentValidationView,
  isKeyframeMismatchOnly,
  NOISE_CHROMA_STRUCTURE_RATIO,
} from "../src/clip-content-validate.js";
import type { ClipJob } from "../src/clip-job-model.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#1153. film-7e6a4d3a: one good clip at similarity 0.149 failed a film and dropped 19 paid clips.
const env = { VIDEO_FINISH_URL: "https://video-finish.test" } as unknown as Env;
const job = (): ClipJob => ({
  job_id: "j", project: "p", motion_backend: "cf-seedance", binding: "M", created_at: 0,
  shots: [{ shot_id: "s1", keyframe_url: "u", prompt: "x", seconds: 6, status: "done", clip_key: "c.mp4" }],
}) as unknown as ClipJob;

const verdict = (ratio?: number) => async () => ({
  verdict: "corrupt" as const,
  reason: "first frame does not resemble its keyframe (similarity 0.149 < 0.200)",
  keyframe_similarity: 0.149,
  ...(ratio === undefined ? {} : {
    metrics: { sat_mean: 1, gray_std_mean: 1, chroma_structure_ratio: ratio, frames: 12 },
  }),
});

describe("a keyframe mismatch on real pixels", () => {
  it("delivers the clip with a named degrade", async () => {
    const j = job();
    expect(await contentValidateDoneClips(env, j, verdict(1.5))).toBe(true);
    expect(j.shots[0].status).toBe("done");
    expect(j.shots[0].error).toBeUndefined();
    expect(j.shots[0].content_degraded).toContain("similarity 0.149");
    expect(j.shots[0].content_validated).toBe("suspect");
  });

  it("shows the degrade on the render record", async () => {
    const j = job();
    await contentValidateDoneClips(env, j, verdict(1.5));
    expect(contentValidationView(j)?.degraded).toEqual([
      { shot_id: "s1", reason: expect.stringContaining("similarity 0.149") },
    ]);
  });

  it("is not inspected again", async () => {
    const j = job();
    await contentValidateDoneClips(env, j, verdict(1.5));
    let calls = 0;
    await contentValidateDoneClips(env, j, async () => { calls++; return { verdict: "corrupt" }; });
    expect(calls).toBe(0);
  });
});

describe("what still fails the shot", () => {
  it("a mismatch with the noise metric over the line", async () => {
    const j = job();
    await contentValidateDoneClips(env, j, verdict(6.0));
    expect(j.shots[0].status).toBe("failed");
    expect(j.shots[0].content_validated).toBe("corrupt");
  });
  it("a mismatch with no metric, since nothing shows it is real", async () => {
    const j = job();
    await contentValidateDoneClips(env, j, verdict());
    expect(j.shots[0].status).toBe("failed");
  });
  it("the line itself: at the limit is real, above it is noise", () => {
    const at = (r: number) => isKeyframeMismatchOnly({
      metrics: { sat_mean: 1, gray_std_mean: 1, chroma_structure_ratio: r, frames: 1 },
    });
    expect(at(NOISE_CHROMA_STRUCTURE_RATIO)).toBe(true);
    expect(at(NOISE_CHROMA_STRUCTURE_RATIO + 0.01)).toBe(false);
    expect(at(Number.NaN)).toBe(false);
  });
});

describe("a clean job", () => {
  it("CONTROL: has no degraded key", async () => {
    const j = job();
    await contentValidateDoneClips(env, j, async () => ({ verdict: "ok" as const }));
    expect(contentValidationView(j)).toEqual({ checked: 1, unmeasured: 0, reasons: [] });
  });
});
