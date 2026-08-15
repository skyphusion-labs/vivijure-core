// core#182 -- the 90min phase ceiling killed a CORRECTLY-RUNNING finish step.
//
// THE MECHANISM. `PHASE_HARD_DEADLINE_SECONDS` fails a pollable phase that has shown no progress.
// `filmProgressMarker` deliberately does not count `attempts` (a step retrying is not a step
// progressing), so a chain step can burn FINISH_STEP_MAX_ATTEMPTS whole invocations against a clock
// that never re-stamps. Whether that fits under 90 minutes is a fact about the MODULE, and the
// ordering between a door's own guard and this ceiling spanned separate repositories with nothing
// asserting it. Measured on the four finish doors, it is ALREADY violated: one sums its per-call
// guards to 6000s (> 5400s on the FIRST attempt) and one has no wall-clock guard at all.
//
// THE FIX under test is not a bigger constant. `max_invocation_seconds` is an optional, additive
// manifest field by which a module states the guard IT enforces, and the ceiling becomes
//
//     effective = max(PHASE_HARD_DEADLINE_SECONDS, FINISH_STEP_MAX_ATTEMPTS * max declared in play)
//
// so the 90 minutes is a FLOOR rather than a guess, and no new constant exists. The CONFORMANCE
// requirement that forces a module to declare is SEQUENCED to core#223, to land with the
// declarations that satisfy it rather than red in a shared repo.
//
// WHAT THESE TESTS ARE CAREFUL ABOUT. Every declared value here is NON-DEFAULT and distinct from
// every other, because on a default an honoured declaration and a substituted one are byte-identical.
// The negative cases (undeclared, unresolved, out of scope) are the discriminating ones: a suite that
// only proved "a declaring chain gets a bigger number" would pass identically against an
// implementation that raised the constant for everybody, which is the fix this issue rules out.
import { describe, expect, it } from "vitest";
import {
  FINISH_STEP_MAX_ATTEMPTS,
  PHASE_HARD_DEADLINE_SECONDS,
  phaseCeiling,
  phaseCeilingVerdict,
} from "../src/film-model.js";
import type { FilmJob, FinishShot, SpeechShot } from "../src/film-model.js";
import { checkManifest } from "../src/modules/conformance.js";
import { validateManifest } from "../src/modules/manifest-validate.js";
import { CEILING_DERIVED_HOOKS, MODULE_API } from "../src/modules/types.js";
import type { RegisteredModule } from "../src/modules/types.js";

// Distinct, non-round, non-default values so no assertion below can be satisfied by a coincidence.
const BLENDER_SECONDS = 6000; // measured: vivijure-blender's per-call guards sum to this on one attempt
const UPSCALE_SECONDS = 1200; // measured: vivijure-upscale's single shared FFMPEG_TIMEOUT
const TINY_SECONDS = 37;      // small enough that 3x it stays under the floor

function mod(name: string, binding: string, seconds?: number, hooks: string[] = ["finish"]): RegisteredModule {
  return {
    name,
    version: "1.0.0",
    api: MODULE_API,
    hooks: hooks as RegisteredModule["hooks"],
    binding,
    ...(seconds === undefined ? {} : { max_invocation_seconds: seconds }),
  } as RegisteredModule;
}

function finishShot(over: Partial<FinishShot> = {}): FinishShot {
  return {
    shot_id: "shot_01",
    clip_key: "renders/p/clips/shot_01.mp4",
    chain: ["MODULE_FINISH_UPSCALE"],
    idx: 0,
    status: "pending",
    applied: [],
    ...over,
  };
}

function speechShot(over: Partial<SpeechShot> = {}): SpeechShot {
  return {
    shot_id: "shot_01",
    audio_key: "renders/p/dialogue/shot_01.wav",
    chain: ["MODULE_SPEECH_UPSCALE"],
    idx: 0,
    status: "pending",
    applied: [],
    ...over,
  };
}

function filmAt(phase: FilmJob["phase"], over: Partial<FilmJob> = {}): FilmJob {
  return {
    film_id: "film-182",
    project: "p",
    phase,
    created_at: 0,
    phase_started_at: 0,
    ...over,
  } as unknown as FilmJob;
}

describe("core#182 the stall ceiling is sized to the work, not to a constant", () => {
  it("CONTROL: with NOTHING declared the ceiling is byte-for-byte today's behaviour", () => {
    // Without this, every "the ceiling rose" assertion below could be satisfied by an implementation
    // that simply raised the constant for everybody, which is the fix this issue explicitly rules out.
    const job = filmAt("finish", { finish_shots: [finishShot()] });
    const c = phaseCeiling(job, [mod("finish-upscale", "MODULE_FINISH_UPSCALE")]);
    expect(c.seconds).toBe(PHASE_HARD_DEADLINE_SECONDS);
    expect(c.basis).toBe("floor");
    expect(c.requiredSeconds).toBe(0);
    expect(c.longest).toBeNull();
  });

  it("MEASURED: a declaring chain raises the ceiling to attempts x its own declared guard", () => {
    const job = filmAt("finish", {
      finish_shots: [finishShot({ chain: ["MODULE_FINISH_BLENDER"] })],
    });
    const c = phaseCeiling(job, [mod("finish-blender", "MODULE_FINISH_BLENDER", BLENDER_SECONDS)]);
    expect(c.basis).toBe("derived");
    expect(c.requiredSeconds).toBe(FINISH_STEP_MAX_ATTEMPTS * BLENDER_SECONDS);
    expect(c.seconds).toBe(FINISH_STEP_MAX_ATTEMPTS * BLENDER_SECONDS);
    expect(c.longest).toEqual({ binding: "MODULE_FINISH_BLENDER", module: "finish-blender", seconds: BLENDER_SECONDS });
    // The whole point: this is a function of the declaration, not a bigger constant.
    expect(c.seconds).toBeGreaterThan(PHASE_HARD_DEADLINE_SECONDS);
  });

  it("MEASURED: the constant is a FLOOR -- a small declaration can never LOWER the ceiling", () => {
    // A module declaring 37s must not shrink the window to 111s and start killing healthy renders.
    // This is the direction the derivation must never move, and it is the one a naive
    // `seconds = attempts * declared` would get wrong while every other test here still passed.
    const job = filmAt("finish", { finish_shots: [finishShot({ chain: ["MODULE_TINY"] })] });
    const c = phaseCeiling(job, [mod("tiny", "MODULE_TINY", TINY_SECONDS)]);
    expect(c.requiredSeconds).toBe(FINISH_STEP_MAX_ATTEMPTS * TINY_SECONDS);
    expect(c.seconds).toBe(PHASE_HARD_DEADLINE_SECONDS);
    expect(c.basis).toBe("floor");
  });

  it("THE DEFECT, driven at the real seam: a single-step chain that used to die at 90min now survives its declared budget", () => {
    // This is #182's exact configuration: ONE shot, a chain of ONE step, so there is nothing between
    // "started" and "done" for the progress marker to observe. The step is running correctly.
    const job = filmAt("finish", {
      finish_shots: [finishShot({ chain: ["MODULE_FINISH_BLENDER"] })],
      phase_started_at: 0,
    });
    const modules = [mod("finish-blender", "MODULE_FINISH_BLENDER", BLENDER_SECONDS)];

    // At the old constant the render was killed. It must now survive.
    const atOldCeiling = phaseCeilingVerdict(job, modules, PHASE_HARD_DEADLINE_SECONDS * 1000);
    expect(atOldCeiling.expired).toBe(false);
    expect(atOldCeiling.error).toBeNull();

    // And it still dies LOUDLY once the module's own declared budget is genuinely exhausted -- the
    // failure is deferred, never removed. A ceiling that could no longer fire would be a worse defect
    // than the one being fixed.
    const budget = FINISH_STEP_MAX_ATTEMPTS * BLENDER_SECONDS;
    const atDerivedCeiling = phaseCeilingVerdict(job, modules, budget * 1000);
    expect(atDerivedCeiling.expired).toBe(true);
    expect(atDerivedCeiling.error).toContain("finish-blender");
    expect(atDerivedCeiling.error).toContain(String(budget));
    // The message states the BASIS, so a derived kill is distinguishable from a floor kill without
    // reading the code.
    expect(atDerivedCeiling.error).toContain("derived from");
  });

  it("MEASURED: an UNDECLARED module gets no substituted number -- the floor holds and it is NAMED", () => {
    // The honest half. A fabricated ceiling would be indistinguishable from a declared one, which is
    // the exact defect class this change exists to remove.
    const job = filmAt("finish", {
      finish_shots: [
        finishShot({ shot_id: "a", chain: ["MODULE_FINISH_BLENDER"] }),
        finishShot({ shot_id: "b", chain: ["MODULE_FINISH_LIPSYNC"] }),
      ],
    });
    const c = phaseCeiling(job, [
      mod("finish-blender", "MODULE_FINISH_BLENDER", BLENDER_SECONDS),
      mod("finish-lipsync", "MODULE_FINISH_LIPSYNC"), // no wall-clock guard exists to declare
    ]);
    expect(c.undeclared).toEqual(["MODULE_FINISH_LIPSYNC"]);
    expect(c.unresolved).toEqual([]);
    // The declaring module still raises the ceiling; the undeclared one is reported, not guessed at.
    expect(c.seconds).toBe(FINISH_STEP_MAX_ATTEMPTS * BLENDER_SECONDS);
  });

  it("MEASURED: a chain step resolving to NO registered module is reported separately from an undeclared one", () => {
    // Collapsing these would hide a different defect (a chain referencing a module the registry no
    // longer serves) inside the one this issue is about.
    const job = filmAt("finish", { finish_shots: [finishShot({ chain: ["MODULE_GONE"] })] });
    const c = phaseCeiling(job, [mod("finish-upscale", "MODULE_FINISH_UPSCALE", UPSCALE_SECONDS)]);
    expect(c.unresolved).toEqual(["MODULE_GONE"]);
    expect(c.undeclared).toEqual([]);
    expect(c.seconds).toBe(PHASE_HARD_DEADLINE_SECONDS);
  });

  it("MEASURED: across shots it takes the MAX, because any shot advancing re-stamps the clock", () => {
    // `min` is the tighter reading and the one that kills correct work: the ceiling must not fire
    // while ANY correctly-running invocation is still inside its own door's guard.
    const job = filmAt("finish", {
      finish_shots: [
        finishShot({ shot_id: "a", chain: ["MODULE_FINISH_UPSCALE"] }),
        finishShot({ shot_id: "b", chain: ["MODULE_FINISH_BLENDER"] }),
      ],
    });
    const c = phaseCeiling(job, [
      mod("finish-upscale", "MODULE_FINISH_UPSCALE", UPSCALE_SECONDS),
      mod("finish-blender", "MODULE_FINISH_BLENDER", BLENDER_SECONDS),
    ]);
    expect(c.longest?.module).toBe("finish-blender");
    expect(c.seconds).toBe(FINISH_STEP_MAX_ATTEMPTS * BLENDER_SECONDS);
  });

  it("MEASURED: only the step that could run NEXT counts, not the whole chain", () => {
    // A step further down the chain cannot run until the one before it resolves, and a step resolving
    // MOVES the marker and re-stamps the clock -- it starts a fresh window rather than extending this
    // one. Summing the chain would inflate every ceiling and blunt the guard.
    const job = filmAt("finish", {
      finish_shots: [finishShot({ chain: ["MODULE_FINISH_BLENDER", "MODULE_FINISH_UPSCALE"], idx: 1 })],
    });
    const c = phaseCeiling(job, [
      mod("finish-blender", "MODULE_FINISH_BLENDER", BLENDER_SECONDS),
      mod("finish-upscale", "MODULE_FINISH_UPSCALE", UPSCALE_SECONDS),
    ]);
    expect(c.longest?.module).toBe("finish-upscale");
    expect(c.requiredSeconds).toBe(FINISH_STEP_MAX_ATTEMPTS * UPSCALE_SECONDS);
    expect(c.seconds).toBe(PHASE_HARD_DEADLINE_SECONDS); // 3 x 1200 is under the floor
  });

  it("MEASURED: a shot already DONE contributes nothing", () => {
    const job = filmAt("finish", {
      finish_shots: [finishShot({ chain: ["MODULE_FINISH_BLENDER"], idx: 1, status: "done" })],
    });
    const c = phaseCeiling(job, [mod("finish-blender", "MODULE_FINISH_BLENDER", BLENDER_SECONDS)]);
    expect(c.seconds).toBe(PHASE_HARD_DEADLINE_SECONDS);
    expect(c.longest).toBeNull();
  });

  it("MEASURED: the speech phase derives identically (it has the same retry-invisible-to-the-marker shape)", () => {
    const job = filmAt("speech", {
      speech_shots: [speechShot({ chain: ["MODULE_SPEECH_UPSCALE"] })],
    });
    const c = phaseCeiling(job, [mod("speech-upscale", "MODULE_SPEECH_UPSCALE", BLENDER_SECONDS, ["speech"])]);
    expect(c.basis).toBe("derived");
    expect(c.seconds).toBe(FINISH_STEP_MAX_ATTEMPTS * BLENDER_SECONDS);
  });

  it("THE LIMIT, asserted so it is not mistaken for wider than it is: keyframe and clips are untouched", () => {
    // Those phases are ceiling-governed too, but their stall math and recovery paths are different
    // (batch clock, R2 adoption). Extending the derivation there without measuring them would be
    // inventing a guarantee rather than asserting one. A green suite must not imply that coverage.
    for (const phase of ["keyframe", "clips"] as const) {
      const job = filmAt(phase, {
        finish_shots: [finishShot({ chain: ["MODULE_FINISH_BLENDER"] })],
      });
      const c = phaseCeiling(job, [mod("finish-blender", "MODULE_FINISH_BLENDER", BLENDER_SECONDS)]);
      expect(c.seconds).toBe(PHASE_HARD_DEADLINE_SECONDS);
      expect(c.basis).toBe("floor");
    }
    expect([...CEILING_DERIVED_HOOKS].sort()).toEqual(["finish", "speech"]);
  });
});

describe("core#182 the declaration is refused at LOAD when malformed, and required at the GATE", () => {
  const base = { name: "m", version: "1.0.0", api: MODULE_API, hooks: ["finish"], participation: "default" as const };

  it("MEASURED: absent stays legal at load -- absent means UNDECLARED, which is a real state", () => {
    expect(typeof validateManifest(base)).not.toBe("string");
  });

  it("MEASURED: a malformed value does NOT load, so a typo can never read as undeclared", () => {
    // The core multiplies this by FINISH_STEP_MAX_ATTEMPTS. A "1200" or a 0 falling through would
    // either be reported as an absence the module does not have, or produce a zero deadline that
    // fails a healthy render on its first tick.
    for (const bad of ["1200", 0, -1, Number.NaN, Number.POSITIVE_INFINITY, true, null, {}]) {
      const r = validateManifest({ ...base, max_invocation_seconds: bad });
      expect(typeof r, JSON.stringify(bad)).toBe("string");
      expect(String(r)).toContain("max_invocation_seconds");
    }
  });

  // THE GATE IS NOT IN THIS PR, and its absence is deliberate rather than an oversight. Not one
  // first-party `finish` door can declare a value honestly today, so a conformance requirement would
  // land RED in a shared repo and block every other lane -- and a gate that blocks correct work is a
  // gate that gets switched off. It lands with the declarations that satisfy it (core#223).
  //
  // What IS asserted here is that `checkManifest` stays SILENT on this field for now, so the day the
  // gate lands it is a visible change rather than something that was quietly half-present.
  it("MEASURED: conformance does not yet speak about this field, and that is the sequencing, not a softening", () => {
    for (const hooks of [["finish"], ["speech"], ["notify"]]) {
      const checks = checkManifest({ ...base, hooks, participation: "default" });
      expect(checks.some((x) => x.name === "max-invocation-seconds"), hooks.join()).toBe(false);
    }
  });
});
