import { describe, expect, it } from "vitest";
import { summarizeFinish } from "../src/film-model.js";
import type { FinishShot } from "../src/film-model.js";

// A finish module that soft-degrades is HONEST at the module boundary: it tags `applied` with
// `passthrough:<reason>` rather than fabricating a success tag (#77/#249). summarizeFinish decides
// what an operator actually SEES, and it dropped that disclosure entirely -- so an all-degraded
// finish stage and an all-succeeded one produced byte-identical summaries. These tests pin the
// distinction; without the `degraded` count they cannot pass.

function shot(over: Partial<FinishShot> = {}): FinishShot {
  return {
    shot_id: "s1",
    clip_key: "clips/s1.mp4",
    chain: ["MODULE_UPSCALE"],
    configs: [{}],
    idx: 1,
    status: "done",
    applied: ["upscale:2x"],
    ...over,
  } as FinishShot;
}

/** Passed through unchanged: reported done, did no work. */
const degradedShot = (id: string): FinishShot =>
  shot({ shot_id: id, applied: ["passthrough:door-token-not-yet-visible"] });

/** Genuinely upscaled. */
const succeededShot = (id: string): FinishShot => shot({ shot_id: id });

describe("summarizeFinish degraded accounting", () => {
  it("makes a degraded stage distinguishable from a succeeded one", () => {
    const allDegraded = summarizeFinish(["a", "b", "c"].map(degradedShot));
    const allSucceeded = summarizeFinish(["a", "b", "c"].map(succeededShot));

    // Every pre-existing field agrees on these two states. That is the whole defect.
    for (const s of [allDegraded, allSucceeded]) {
      expect(s.total).toBe(3);
      expect(s.done).toBe(3);
      expect(s.failed).toBe(0);
      expect(s.pending).toBe(0);
    }

    // THE ASSERTION THAT COULD NOT HAVE PASSED BEFORE.
    expect(allDegraded).not.toEqual(allSucceeded);
    expect(allDegraded.degraded).toBe(3);
    expect(allSucceeded.degraded).toBe(0);
    expect(allDegraded.reasons).toEqual(["door-token-not-yet-visible"]);
    expect(allSucceeded.reasons).toEqual([]);
  });

  it("does NOT count an intentional noop as a degrade", () => {
    // finish.ts draws this line deliberately: a real degrade tags `passthrough:`, an intentional
    // no-op (lip-sync on a shot with no dialogue) tags `noop:` and leaves `degraded` unset. A guard
    // that fires on correct behaviour is the guard people switch off.
    const s = summarizeFinish([
      shot({ shot_id: "a", applied: ["noop:no-dialogue"] }),
      degradedShot("b"),
    ]);
    expect(s.degraded).toBe(1);
  });

  it("counts a shot whose passthrough was ADOPTED from R2, not only one run this pass", () => {
    // A reused step's marker lives in `adopted`, never `applied` (#583). A degrade that is reused
    // is still a degrade, so reading only `applied` would under-report on exactly the resume path.
    const s = summarizeFinish([
      shot({ shot_id: "a", applied: [], adopted: ["passthrough:door-token-not-yet-visible"] }),
    ]);
    expect(s.degraded).toBe(1);
  });

  it("counts a shot once even when several of its steps degraded", () => {
    const s = summarizeFinish([
      shot({ shot_id: "a", applied: ["passthrough:one", "passthrough:two"] }),
    ]);
    expect(s.total).toBe(1);
    expect(s.degraded).toBe(1);
  });

  it("separates a FAILED shot from a degraded one", () => {
    // Failure is already reported by `failed`; degradation is the state that was silent.
    const s = summarizeFinish([
      succeededShot("a"),
      degradedShot("b"),
      shot({ shot_id: "c", status: "failed", applied: [] }),
      shot({ shot_id: "d", status: "pending", applied: [] }),
    ]);
    expect(s.total).toBe(4);
    expect(s.done).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.degraded).toBe(1);
  });

  it("reports zero degraded on an empty stage without inventing a number", () => {
    const s = summarizeFinish([]);
    expect(s.total).toBe(0);
    expect(s.degraded).toBe(0);
    expect(s.reasons).toEqual([]);
  });

  it("counts a shot that set FinishOutput.degraded without a passthrough: tag (#226)", () => {
    // The field is the degrade channel. A module that records the reason and tags applied
    // differently (speech-upscale shape) was previously invisible.
    const s = summarizeFinish([
      shot({ shot_id: "a", applied: [], degraded: ["no detectable face in clip"] }),
    ]);
    expect(s.degraded).toBe(1);
    expect(s.reasons).toEqual(["no detectable face in clip"]);
  });

  it("prefers the degraded field over the generic passthrough: tag, so two causes stay distinct", () => {
    const s = summarizeFinish([
      shot({
        shot_id: "a",
        applied: ["passthrough:backend-soft-degrade"],
        degraded: ["backend-soft-degrade: no detectable face in clip"],
      }),
      shot({
        shot_id: "b",
        applied: ["passthrough:backend-soft-degrade"],
        degraded: ["backend-soft-degrade: wall-clock guard expired after 900s"],
      }),
    ]);
    expect(s.degraded).toBe(2);
    expect(s.reasons).toEqual([
      "backend-soft-degrade: no detectable face in clip",
      "backend-soft-degrade: wall-clock guard expired after 900s",
    ]);
  });
});
