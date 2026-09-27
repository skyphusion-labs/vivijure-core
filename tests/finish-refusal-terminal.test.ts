// A finish-step REFUSAL is a terminal safety decision, not a failure to be recovered from.
// Reference: GHSA-hcr9-8jc2-9q4c.
//
// THE DISTINCTION THIS FILE PINS. `failed` on a finish shot means "this step did not deliver, and a
// later pass may still find the artifact and complete the shot" (the GC'd-job recovery, #141/#166).
// A refusal means "this shot must not be delivered at all". Those are two different terminal facts
// and they must not share a status, because every recovery path in the phase keys off the status:
// one that carried both meanings would hand recovery a shot whose whole point is that it is finished
// being considered.
//
// So `refused` is its own terminal status, it is excluded from the recoverable type by construction
// (finishShotRecoverable is the only way to obtain a RecoverableFinishShot, and it does not admit
// `refused`), and it blocks the phase from assembling exactly as `failed` does.
//
// EVERY REFUSED FIXTURE IS BUILT BY THE REAL REFUSAL PATH, never by writing the status literal. A
// hand-written `status: "refused"` would be a shot no shipped code produces, so a guard that reads
// the status would pass against it whatever the refusal path actually does: the assertion could not
// fail, which makes it decoration. `refused()` below runs applyFinishOutputOrRefuse over a refusing
// module output, so these assertions observe the state the pipeline really reaches.
//
// BOTH DIRECTIONS ARE ASSERTED. The refusal cases prove the guard holds; the CONTROL cases prove the
// recovery the `failed` branch exists for still works. A change that closed the first by disabling
// the second would pass half of this file and is not a fix.

import { describe, expect, it } from "vitest";
import {
  applyFinishOutputOrRefuse,
  finishPhaseBlockers,
  finishShotAdoptableFromR2,
  finishShotBlocksRender,
  finishShotRecoverable,
  reclaimFinishShotsFromR2,
} from "../src/film-model.js";
import type { FinishShot } from "../src/film-model.js";
import type { FinishOutput } from "../src/modules/types.js";

const PROJECT = "p";
const FINAL_CLIP = "renders/p/clips/s1_finished.mp4";
const SOURCE_CLIP = "renders/p/clips/s1_ff0.mp4";
const REASON = "csam refusal: rejected by the content door";

/** A finish shot sitting at its chain's FINAL index, which is the only index R2 adoption considers. */
function atFinalIndex(over: Partial<FinishShot> = {}): FinishShot {
  return {
    shot_id: "s1",
    clip_key: SOURCE_CLIP,
    chain: ["MODULE_RIFE", "MODULE_UPSCALE"],
    configs: [{}, {}],
    idx: 1, // chain.length - 1
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
    applied: [],
    ...over,
  };
}

/** A shot in the state the pipeline ACTUALLY reaches when a module output is refused, produced by the
 *  refusal path itself rather than by asserting the status literal into existence. */
function refused(over: Partial<FinishShot> = {}): FinishShot {
  const fs = atFinalIndex(over);
  applyFinishOutputOrRefuse(fs, out({ degraded: REASON }), PROJECT);
  return fs;
}

/** The artifact IS in R2 for this shot. Present in every case below, so R2 presence is never what
 *  distinguishes the refusal from the control: the shot's own terminal state is. */
const presentInR2 = () => new Map([["s1", FINAL_CLIP]]);

describe("a refused finish shot is terminal and no recovery path may act on it", () => {
  it("the refusal path lands its own terminal status, with the reason kept", () => {
    const fs = refused();
    expect(fs.status).toBe("refused");
    expect(fs.error).toBe(REASON);
    expect(fs.poll).toBeUndefined();
    expect(fs.idx).toBe(1);         // the step did not advance
    expect(fs.applied).toEqual([]); // and it claimed no work
    expect(fs.degraded).toBeUndefined();
  });

  it("a refused shot is outside the recoverable type, so it cannot reach a recovery path", () => {
    const fs = refused();
    expect(finishShotRecoverable(fs)).toBe(false);
    expect(finishShotAdoptableFromR2(fs)).toBe(false);
  });

  it("reclaim leaves a refused shot refused, reason intact, with the artifact present in R2", () => {
    const fs = refused();
    const adopted = reclaimFinishShotsFromR2([fs], presentInR2());
    expect(adopted).toBe(0);
    expect(fs.status).toBe("refused");
    expect(fs.error).toBe(REASON);
    expect(fs.clip_key).toBe(SOURCE_CLIP); // the R2 artifact was NOT threaded in
    expect(fs.adopted).toBeUndefined();
    expect(fs.ledger).toBeUndefined();
  });

  it("a refusal carried only on an applied tag is terminal too, not just one on `degraded`", () => {
    const fs = atFinalIndex();
    applyFinishOutputOrRefuse(fs, out({ applied: ["passthrough:csam"] }), PROJECT);
    expect(fs.status).toBe("refused");
    reclaimFinishShotsFromR2([fs], presentInR2());
    expect(fs.status).toBe("refused");
    expect(fs.error).toBe("csam refusal");
    expect(fs.clip_key).toBe(SOURCE_CLIP);
  });

  it("a refused shot blocks the phase, so the film fails loud instead of assembling", () => {
    const fs = refused();
    const done = atFinalIndex({ shot_id: "s2", status: "done", clip_key: FINAL_CLIP });
    expect(finishShotBlocksRender(fs)).toBe(true);
    expect(finishPhaseBlockers([done, fs]).map((s) => s.shot_id)).toEqual(["s1"]);
  });

  it("a refusal mid-chain is terminal as well, at every index and after a reclaim pass", () => {
    const fs = refused({ idx: 0 });
    expect(fs.status).toBe("refused");
    expect(finishShotAdoptableFromR2(fs)).toBe(false);
    reclaimFinishShotsFromR2([fs], presentInR2());
    expect(fs.status).toBe("refused");
    expect(finishShotBlocksRender(fs)).toBe(true);
  });
});

describe("CONTROL: the transient-failure recovery the failed branch exists for still works", () => {
  it("a failed shot at the final index with the artifact in R2 is still adopted (#141)", () => {
    const fs = atFinalIndex({ status: "failed", error: "module /poll -> 404 job not found" });
    expect(finishShotRecoverable(fs)).toBe(true);
    expect(finishShotAdoptableFromR2(fs)).toBe(true);
    const adopted = reclaimFinishShotsFromR2([fs], presentInR2());
    expect(adopted).toBe(1);
    expect(fs.status).toBe("done");
    expect(fs.clip_key).toBe(FINAL_CLIP);
    expect(fs.error).toBeUndefined();   // correct HERE: the finished artifact is the source of truth
    expect(fs.poll).toBeUndefined();
    expect(fs.adopted).toHaveLength(1); // disclosed as reused, never as a run (#583)
    expect(fs.ledger).toHaveLength(1);
    expect(fs.ledger?.[0].reused).toBe(true);
  });

  it("a pending shot frozen on its final step with the artifact in R2 is still adopted (RUN #29)", () => {
    const fs = atFinalIndex({ status: "pending", poll: "job-abc" });
    expect(finishShotAdoptableFromR2(fs)).toBe(true);
    expect(reclaimFinishShotsFromR2([fs], presentInR2())).toBe(1);
    expect(fs.status).toBe("done");
    expect(fs.clip_key).toBe(FINAL_CLIP);
  });

  it("a mid-chain failed shot is still not adopted, so no half-finished clip ships", () => {
    const fs = atFinalIndex({ idx: 0, status: "failed", error: "module /poll -> 404 job not found" });
    expect(finishShotAdoptableFromR2(fs)).toBe(false);
    expect(reclaimFinishShotsFromR2([fs], presentInR2())).toBe(0);
    expect(fs.status).toBe("failed");
  });

  it("a non-refusal soft degrade still folds and advances, so the chain never fails on polish", () => {
    const fs = atFinalIndex({ idx: 0 });
    applyFinishOutputOrRefuse(fs, out({
      applied: ["passthrough:backend-soft-degrade"],
      degraded: "backend-soft-degrade: no detectable face in clip",
    }), PROJECT);
    expect(fs.status).toBe("pending");
    expect(fs.idx).toBe(1);
    expect(fs.degraded).toEqual(["backend-soft-degrade: no detectable face in clip"]);
    expect(fs.error).toBeUndefined();
  });

  it("a genuinely failed shot still blocks the phase, and a done or pending one does not", () => {
    expect(finishShotBlocksRender(atFinalIndex({ status: "failed" }))).toBe(true);
    expect(finishShotBlocksRender(atFinalIndex({ status: "done" }))).toBe(false);
    expect(finishShotBlocksRender(atFinalIndex({ status: "pending" }))).toBe(false);
    expect(finishPhaseBlockers([atFinalIndex({ status: "done" })])).toEqual([]);
  });
});
