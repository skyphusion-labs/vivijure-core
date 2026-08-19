// core#182 -- the 90min phase ceiling killed a correctly-running finish step.
//
// The ceiling measures from `last_progress_at`, which is re-stamped only when the progress marker
// CHANGES, and the marker counted finished SHOTS. So a film whose last remaining shot was working
// through its finish chain produced NO marker change for the whole shot, and the ceiling fired on
// work proceeding exactly as configured.
//
// These tests drive the REAL seam (`stampFilmProgress`), which was extracted from advanceFilmJob for
// exactly this reason: inline, a test could only have RESTATED the compare-and-stamp, and a test that
// restates its subject agrees with it forever.
//
// The last test in this file asserts what the fix does NOT cover. That is deliberate: a green suite
// with no such case would imply #182 is closed, and it is not.
import { describe, expect, it } from "vitest";
import {
  PER_SHOT_PHASES,
  PHASE_HARD_DEADLINE_SECONDS,
  POLLABLE_PHASES,
  ceilingAgeSeconds,
  filmProgressMarker,
  stampFilmProgress,
} from "../src/film-model.js";
import type { FilmJob, FinishShot, SpeechShot } from "../src/film-model.js";

function finishShot(over: Partial<FinishShot> = {}): FinishShot {
  return {
    shot_id: "shot_01",
    clip_key: "renders/p/clips/shot_01.mp4",
    chain: ["MODULE_FINISH_UPSCALE", "MODULE_FINISH_LIPSYNC", "MODULE_FINISH_RIFE"],
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

describe("core#182 filmProgressMarker sees per-step progress", () => {
  it("CONTROL: the marker still moves on a finished shot and on a phase transition", () => {
    // Without this, every "the marker moved" assertion below could be satisfied by a marker that
    // moves on literally anything, which would be a different defect wearing the fix's clothes.
    const a = filmAt("finish", { finish_shots: [finishShot({ idx: 3, status: "done" })] });
    const b = filmAt("finish", { finish_shots: [finishShot({ idx: 0, status: "pending" })] });
    expect(filmProgressMarker(a, null)).not.toBe(filmProgressMarker(b, null));
    expect(filmProgressMarker(filmAt("finish"), null)).not.toBe(
      filmProgressMarker(filmAt("mux"), null),
    );
    // Phases with no per-shot fan-out are unchanged in behaviour: one constant value.
    expect(filmProgressMarker(filmAt("keyframe"), null)).toBe(
      filmProgressMarker(filmAt("keyframe"), null),
    );
  });

  it("MEASURED: ONE shot walking a 3-step chain produces 3 distinct markers, not 1", () => {
    const seen = new Set<string>();
    for (const idx of [0, 1, 2, 3]) {
      const job = filmAt("finish", {
        finish_shots: [finishShot({ idx, status: idx >= 3 ? "done" : "pending" })],
      });
      seen.add(filmProgressMarker(job, null));
    }
    // Pre-fix this set had size 2: "finish:0" for idx 0..2 and "finish:1" at the end. The whole
    // chain looked like a single instant of progress at the very end.
    expect(seen.size).toBe(4);
  });

  it("MEASURED: a step resolving mid-shot re-stamps the ceiling clock, so the film survives", () => {
    const T0 = 1_000_000_000_000;
    const job = filmAt("finish", {
      finish_shots: [finishShot({ idx: 0 })],
      phase_started_at: T0,
      created_at: T0,
    });
    expect(PER_SHOT_PHASES.has("finish")).toBe(true); // the ceiling really does use last_progress_at here
    expect(PER_SHOT_PHASES.has("pre_clip_speech")).toBe(true);
    expect(PER_SHOT_PHASES.has("pre_clip_dialogue")).toBe(false);
    expect(POLLABLE_PHASES.has("pre_clip_dialogue")).toBe(true);
    expect(POLLABLE_PHASES.has("pre_clip_speech")).toBe(true);
    expect(POLLABLE_PHASES.has("dialogue")).toBe(false);
    stampFilmProgress(job, null, T0); // phase entry

    // 80 minutes in, still inside the ceiling, and the shot resolves its FIRST chain step.
    const T1 = T0 + 80 * 60 * 1000;
    job.finish_shots![0].idx = 1;
    expect(stampFilmProgress(job, null, T1)).toBe(true); // pre-fix: false, the marker had not moved

    // 80 minutes after that, the second step lands. Total elapsed 160min, well past the 90min
    // ceiling, and the phase is healthy the whole way.
    const T2 = T1 + 80 * 60 * 1000;
    expect(ceilingAgeSeconds(job, T2)).toBeLessThan(PHASE_HARD_DEADLINE_SECONDS);
    console.log(
      `core#182: elapsed=${Math.round((T2 - T0) / 60000)}min ceilingAge=${ceilingAgeSeconds(job, T2)}s ` +
        `deadline=${PHASE_HARD_DEADLINE_SECONDS}s`,
    );
  });

  it("MEASURED: a step RETRYING is not progress and must not re-stamp the clock", () => {
    // `attempts` is deliberately excluded. Folding it in would let a shot failing over and over hold
    // the clock open forever, which converts the ceiling into a check that cannot fire.
    const T0 = 1_000_000_000_000;
    const job = filmAt("finish", { finish_shots: [finishShot({ idx: 1, attempts: 0 })] });
    stampFilmProgress(job, null, T0);
    job.finish_shots![0].attempts = 3;
    job.finish_shots![0].error = "transient (attempt 3/4), retrying";
    expect(stampFilmProgress(job, null, T0 + 60_000)).toBe(false);
    expect(job.last_progress_at).toBe(T0);
  });

  it("MEASURED: speech shots get the same per-step granularity", () => {
    const mk = (idx: number): SpeechShot =>
      ({
        shot_id: "shot_01",
        audio_key: "a.wav",
        chain: ["MODULE_SPEECH_UPSCALE", "MODULE_SPEECH_B"],
        idx,
        status: idx >= 2 ? "done" : "pending",
        applied: [],
      }) as unknown as SpeechShot;
    const seen = new Set([0, 1, 2].map((i) => filmProgressMarker(filmAt("speech", { speech_shots: [mk(i)] }), null)));
    expect(seen.size).toBe(3);
  });

  it("THE LIMIT of the MARKER, and where it is now covered: a SINGLE-STEP chain has no intra-shot progress", () => {
    // A finish chain of just `finish-upscale` is one step, so there is nothing between "started" and
    // "done" for any marker to observe. This is the exact configuration #182 describes, and NO marker
    // can cover it -- the limit below is permanent and this assertion stays.
    //
    // It is no longer the whole of #182, and this comment is corrected rather than deleted so the
    // reason is legible: that case needed a ceiling sized to the WORK, not a finer marker, which is
    // what `phaseCeiling` / `phaseCeilingVerdict` now provide from the modules' own declared
    // `max_invocation_seconds`. See `tests/phase-ceiling-182`. What the assertions below still prove
    // is that the MARKER does not see it, which is exactly why the ceiling had to.
    const one = (idx: number) =>
      filmAt("finish", {
        finish_shots: [
          finishShot({ chain: ["MODULE_FINISH_UPSCALE"], idx, status: idx >= 1 ? "done" : "pending" }),
        ],
      });
    const before = filmProgressMarker(one(0), null);
    const after = filmProgressMarker(one(1), null);
    expect(before).not.toBe(after); // it moves exactly once, at the end
    const job = one(0);
    stampFilmProgress(job, null, 0);
    // ...and nothing in between re-stamps. Whether the render then DIES is no longer this file's
    // question: with nothing declared the floor still kills it exactly as before (the CONTROL in
    // tests/phase-ceiling-182), and with a declaration the ceiling moves out to the module's own
    // budget. The marker's blindness is what is asserted here.
    expect(stampFilmProgress(job, null, PHASE_HARD_DEADLINE_SECONDS * 1000)).toBe(false);
    expect(ceilingAgeSeconds(job, PHASE_HARD_DEADLINE_SECONDS * 1000)).toBeGreaterThanOrEqual(
      PHASE_HARD_DEADLINE_SECONDS,
    );
  });
});
