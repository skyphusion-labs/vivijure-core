/// <reference types="node" />
// cf#507b: the MEASURED source dimensions a finish dispatch carries, and -- the point of this file
// -- what happens when the lookup MISSES.
//
// WHY THE MISS IS THE SUBJECT. The clip shots live on a SEPARATE R2 document from the finish shots,
// so this lookup can miss for four real reasons: no clip_job_id, no document, an unparseable
// document, or no matching shot_id. If any of those produced a guessed dimension we would have
// rebuilt `?? 1920` a third time, inside the change removing it. Absence is honest in this contract
// -- FinishInput.width/height are documented as hints the backend PROBES for when absent -- so the
// correct behaviour on a miss is NO ENTRY, and every assertion below pins that.
//
// SCOPE, STATED RATHER THAN IMPLIED. This file tests the lookup, which is where the guessing risk
// lives. It does NOT assert that advanceFinishPhase puts the result on the wire; my first attempt at
// that harness never reached the dispatch (seen.length 0) and only the denominator guard revealed
// it -- four of six assertions would otherwise have passed vacuously on undefined === undefined.
// That dispatch-level assertion is genuinely missing and is called out in the PR body rather than
// papered over with a test that cannot fail.

import { describe, expect, it } from "vitest";
import { measuredClipDimensions } from "../src/film-orchestrator.js";

const SHOT = "shot_01";

/** An env whose clip-doc GET returns exactly what a case wants. `undefined` => no object at all. */
function envWith(doc: unknown) {
  return {
    R2_RENDERS: {
      get: async () => (doc === undefined ? null : { text: async () => (typeof doc === "string" ? doc : JSON.stringify(doc)) }),
    },
  } as unknown as Parameters<typeof measuredClipDimensions>[0];
}
const jobWith = (clipJobId?: string) => ({ clip_job_id: clipJobId } as unknown as Parameters<typeof measuredClipDimensions>[1]);

const docWith = (shots: unknown[]) => ({ job_id: "cj1", shots });

describe("measuredClipDimensions: a HIT is a measurement", () => {
  it("returns the probed dimensions for a shot that recorded them", async () => {
    // 864x496 is the real draft geometry, deliberately not 1920x1080 on either axis: a fabricated
    // default would be visible here rather than blending into the expected value.
    const m = await measuredClipDimensions(
      envWith(docWith([{ shot_id: SHOT, status: "done", delivered_width: 864, delivered_height: 496 }])),
      jobWith("cj1"),
    );
    expect(m.size).toBe(1);                       // denominator: an empty map is the failure mode
    expect(m.get(SHOT)).toEqual({ width: 864, height: 496 });
  });

  it("maps several shots independently, so one bad row cannot poison the others", async () => {
    const m = await measuredClipDimensions(
      envWith(docWith([
        { shot_id: "a", delivered_width: 1280, delivered_height: 720 },
        { shot_id: "b", delivered_width: 864, delivered_height: 496 },
        { shot_id: "c" },                                    // never measured -> no entry
      ])),
      jobWith("cj1"),
    );
    expect(m.size).toBe(2);
    expect(m.get("a")).toEqual({ width: 1280, height: 720 });
    expect(m.get("b")).toEqual({ width: 864, height: 496 });
    expect(m.has("c")).toBe(false);              // absent, NOT zero and NOT defaulted
  });
});

describe("measuredClipDimensions: every MISS is an absence, never a guess", () => {
  it("no clip_job_id -> empty", async () => {
    const m = await measuredClipDimensions(envWith(docWith([])), jobWith(undefined));
    expect(m.size).toBe(0);
  });

  it("no clip document -> empty, and it does not throw", async () => {
    const m = await measuredClipDimensions(envWith(undefined), jobWith("cj1"));
    expect(m.size).toBe(0);
  });

  it("unparseable document -> empty, and it does not throw", async () => {
    const m = await measuredClipDimensions(envWith("{ not json"), jobWith("cj1"));
    expect(m.size).toBe(0);
  });

  it("shot present but dimensions never recorded -> NO ENTRY rather than zero", async () => {
    // The subtle one. A zero-valued entry would satisfy a `has()` check and then letterbox the film
    // into nothing downstream. Absent and zero must not be the same observation.
    for (const bad of [
      { shot_id: SHOT, status: "done" },
      { shot_id: SHOT, delivered_width: 0, delivered_height: 0 },
      { shot_id: SHOT, delivered_width: 864 },                       // half-measured
      { shot_id: SHOT, delivered_width: Number.NaN, delivered_height: 496 },
      { shot_id: SHOT, delivered_width: -864, delivered_height: -496 },
    ]) {
      const m = await measuredClipDimensions(envWith(docWith([bad])), jobWith("cj1"));
      expect(m.has(SHOT)).toBe(false);
    }
  });

  it("CONTROL: the same harness DOES produce an entry, so the zeros above discriminate", async () => {
    // Without this, every assertion in this describe block is satisfied by a broken harness that
    // can only ever return an empty map -- which is exactly the shape that would let a real
    // regression through unnoticed.
    const m = await measuredClipDimensions(
      envWith(docWith([{ shot_id: SHOT, delivered_width: 1001, delivered_height: 337 }])),
      jobWith("cj1"),
    );
    expect(m.get(SHOT)).toEqual({ width: 1001, height: 337 });
  });
});
