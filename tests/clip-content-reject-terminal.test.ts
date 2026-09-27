// A clip the content gate REJECTED is terminal, and the R2-presence reclaim must not undo that.
// Reference: GHSA-hcr9-8jc2-9q4c.
//
// THE SAME DISTINCTION AS THE FINISH LEG, one leg over. `failed` on a clip shot means "this shot did
// not deliver, and the artifact may yet be found and adopted" (#141). But Layer 2 (the pixel /
// keyframe-similarity gate) also parks its verdict on `failed`, and a "corrupt" verdict is a
// REJECTION: a decision that this artifact must not be delivered. The artifact is still sitting in R2,
// because being in R2 is exactly what it was judged on.
//
// The pre-existing exclusion is the proof this shape was already understood here: the reclaim filter
// already skips `validated !== "fail"`, which is Layer 1 (structural) doing precisely this. Layer 2
// had no equivalent, and because its own idempotence flag (`content_validated`) suppresses
// re-inspection, a re-adopted clip is never re-judged.
//
// WHAT THE CONTROLS ARE FOR. `corrupt` must be the ONLY content verdict that blocks recovery. `ok` and
// `suspect` are not rejections (`suspect` is warn-and-degrade by design), so a shot carrying either
// must still be recoverable, or this fix would quietly disable #141 for every clip the gate has ever
// looked at. That is the failure mode a narrower test would miss.

import { describe, expect, it } from "vitest";
import { reclaimClipsFromR2 } from "../src/render-orchestrator.js";
import type { ClipJob, ClipShot } from "../src/clip-job-model.js";
import type { Env } from "../src/platform/orchestrator-context.js";

const PROJECT = "neon";
const CLIP = "renders/neon/clips/shot_01_i2v.mp4";

/** A clip job with one shot, at `created_at: 0` so the #661 freshness floor is inactive and the
 *  candidate is judged on provenance alone (no sidecar present -> adopted with a stamp). */
function jobWith(over: Partial<ClipShot>): ClipJob {
  return {
    job_id: "j", project: PROJECT, motion_backend: "seedance", binding: "MODULE_SEEDANCE",
    created_at: 0,
    shots: [{
      shot_id: "shot_01", keyframe_url: "u", prompt: "x", seconds: 5,
      status: "failed", ...over,
    } as ClipShot],
  };
}

/** An env where the clip IS present in R2 for every case, so presence is never what distinguishes
 *  them: the shot's own terminal state is. Records puts so a stamp is visible. */
function envWithClip() {
  const puts: string[] = [];
  const env = {
    R2_RENDERS: {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [CLIP].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, uploaded: new Date(1000) })),
        truncated: false,
      }),
      get: async () => null,   // no provenance sidecar -> the unstamped-single-candidate path
      head: async () => null,
      put: async (k: string) => { puts.push(k); },
    },
  } as unknown as Env;
  return { env, puts };
}

describe("a content-REJECTED clip is terminal and is not re-adopted from R2", () => {
  it("leaves a corrupt-verdict shot failed, with its verdict and reason intact", async () => {
    const cj = jobWith({
      content_validated: "corrupt",
      error: "clip failed content validation: does not resemble its keyframe",
    });
    const { env } = envWithClip();
    const adopted = await reclaimClipsFromR2(env, cj);
    expect(adopted).toBe(0);
    expect(cj.shots[0].status).toBe("failed");
    expect(cj.shots[0].content_validated).toBe("corrupt");       // the verdict survives
    expect(cj.shots[0].error).toBe("clip failed content validation: does not resemble its keyframe");
    expect(cj.shots[0].clip_key).toBeUndefined();                // the artifact was NOT threaded in
  });

  it("does not re-adopt it even on a second pass, which is how the verdict would be lost", async () => {
    const cj = jobWith({ content_validated: "corrupt", error: "clip failed content validation: x" });
    const { env } = envWithClip();
    await reclaimClipsFromR2(env, cj);
    await reclaimClipsFromR2(env, cj);
    expect(cj.shots[0].status).toBe("failed");
    expect(cj.shots[0].content_validated).toBe("corrupt");
  });
});

describe("CONTROL: the #141 recovery this filter exists for still works", () => {
  it("a plainly failed shot whose clip is in R2 is still adopted", async () => {
    const cj = jobWith({ error: "own-gpu job not found on RunPod (#141)" });
    const { env, puts } = envWithClip();
    const adopted = await reclaimClipsFromR2(env, cj);
    expect(adopted).toBe(1);
    expect(cj.shots[0].status).toBe("done");
    expect(cj.shots[0].clip_key).toBe(CLIP);
    expect(cj.shots[0].error).toBeUndefined();     // correct HERE: the artifact is the source of truth
    expect(cj.shots[0].validated).toBeUndefined(); // #523: re-validate the freshly adopted artifact
    expect(puts.length).toBeGreaterThan(0);        // and its provenance was stamped
  });

  it("a pending shot whose clip is in R2 is still adopted", async () => {
    const cj = jobWith({ status: "pending", poll: "phantom" });
    const { env } = envWithClip();
    expect(await reclaimClipsFromR2(env, cj)).toBe(1);
    expect(cj.shots[0].status).toBe("done");
  });

  it("DISCRIMINATOR: only `corrupt` blocks recovery; `ok` and `suspect` do not", async () => {
    // suspect is warn-and-degrade by design, and ok is a pass. If either blocked recovery, this fix
    // would have disabled #141 for every clip the content gate has ever inspected.
    for (const verdict of ["ok", "suspect", "skip"] as const) {
      const cj = jobWith({ content_validated: verdict, error: "transient" });
      const { env } = envWithClip();
      expect(await reclaimClipsFromR2(env, cj)).toBe(1);
      expect(cj.shots[0].status).toBe("done");
      expect(cj.shots[0].content_validated).toBe(verdict); // preserved, not cleared
    }
  });

  it("a Layer 1 structural failure is still excluded, exactly as it is today", async () => {
    // Unchanged behaviour, asserted so this change is visibly additive to the existing exclusion
    // rather than a replacement of it.
    const cj = jobWith({ validated: "fail", error: "clip failed structural validation" });
    const { env } = envWithClip();
    expect(await reclaimClipsFromR2(env, cj)).toBe(0);
    expect(cj.shots[0].status).toBe("failed");
    expect(cj.shots[0].validated).toBe("fail");
  });
});
