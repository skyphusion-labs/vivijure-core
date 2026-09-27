// core#291: the InvokeResponse failure arm carries a MACHINE-READABLE fault class.
//
// WHAT THIS SUITE IS FOR, stated up front because a green run here is easy to misread. The field is
// additive and optional, so nothing breaks on day one whether or not it works; a suite asserting
// "the new field typechecks" would be green on a contract that changed nothing. The failure mode
// worth catching is the OLD BEHAVIOUR SURVIVING THE NEW FIELD -- a consumer that reads `reason` and
// then falls back to inspecting `error` anyway. Prose that AGREES with the declared class cannot
// catch that, so every consumer test below CONTRADICTS the two channels against each other and
// asserts the class wins.

import { describe, it, expect } from "vitest";
import {
  INVOKE_FAILURE_DISPOSITION,
  INVOKE_FAILURE_REASONS,
  isInvokeFailureReason,
  type InvokeFailureReason,
  type InvokeResponse,
} from "../src/modules/types.js";
import { checkInvokeResponse } from "../src/modules/conformance.js";
import { classifyInvokeFailure, classifyTransientFailure } from "../src/render-orchestrator.js";

describe("core#291 InvokeFailureReason: the closed set", () => {
  it("is closed, enumerable, and has no absence-shaped member", () => {
    // Denominator, printed rather than implied: eleven classes, each cited on the type.
    expect(INVOKE_FAILURE_REASONS).toHaveLength(11);
    expect(new Set(INVOKE_FAILURE_REASONS).size).toBe(INVOKE_FAILURE_REASONS.length);
    // #291 acceptance: absence must be distinguishable from unknown. A member that MEANS "unknown"
    // would make "this module has not adopted the field" indistinguishable from "no class applies",
    // which is the very defect the field removes. There must be no such member, by any spelling.
    for (const forbidden of ["unknown", "other", "unclassified", "none", "error"]) {
      expect(INVOKE_FAILURE_REASONS).not.toContain(forbidden);
    }
  });

  it("has a TOTAL disposition map, in both directions", () => {
    // Left to right: every declared class has a disposition. Right to left: the map has no member
    // the union does not. Without the second half the map could carry a dead class forever.
    const mapped = Object.keys(INVOKE_FAILURE_DISPOSITION).sort();
    expect(mapped).toEqual([...INVOKE_FAILURE_REASONS].sort());
    for (const r of INVOKE_FAILURE_REASONS) {
      expect(["transient", "deterministic"]).toContain(INVOKE_FAILURE_DISPOSITION[r]);
    }
  });

  it("never maps an unknown string onto a nearby class", () => {
    expect(isInvokeFailureReason("bad-input")).toBe(true);
    // A typo, a near-miss, and the wrong casing all fail. Membership is not fuzzy matching.
    for (const v of ["bad_input", "badinput", "BAD-INPUT", "quota", "", null, undefined, 7, {}]) {
      expect(isInvokeFailureReason(v)).toBe(false);
    }
  });
});

describe("core#291: the set is DERIVED from failures this codebase already produces", () => {
  // Each pair is a real error string from this repo (cited on the type it maps to) beside the class
  // a module would now declare for it. The assertion is that the two agree, which is what makes
  // adopting `reason` a no-op for behaviour on day one rather than a silent retry-policy change.
  const DERIVATION: Array<[string, InvokeFailureReason]> = [
    ['Invalid request body: field "resolution" must be one of ["720p"]', "bad-input"],
    ["module /invoke -> 429", "rate-limited"],
    ["module /invoke -> 503", "upstream-unavailable"],
    ["module unreachable: fetch failed", "upstream-unavailable"],
    ["AiGatewayError: 7003: Model execution failed", "upstream-unavailable"],
    ["CUDA out of memory", "backend-error"],
    ["RUNPOD_ENDPOINT_ID must be set on the Worker (Secrets Store binding or npx wrangler secret put)", "not-configured"],
    ["module /invoke -> 401", "unauthorized"],
    ["storage quota reached: 900 bytes stored of the 800-byte R2_STORAGE_QUOTA_BYTES ceiling", "quota-exceeded"],
  ];

  it.each(DERIVATION)("prose %j and class %j already agree", (error, reason) => {
    expect(INVOKE_FAILURE_DISPOSITION[reason]).toBe(classifyTransientFailure(error));
  });

  it("the derivation set is a positive control: it CAN disagree", () => {
    // If every pair agreed no matter what was written, the block above would measure nothing. A
    // deliberately wrong pairing must fail the same comparison the suite relies on.
    expect(INVOKE_FAILURE_DISPOSITION["bad-input"]).not.toBe(classifyTransientFailure("module /invoke -> 503"));
  });
});

describe("core#291: a consumer reading `reason` never falls back to `error`", () => {
  // THE test of this issue. In each case the prose says one thing and the declared class says the
  // opposite, so an implementation that still consults the sentence gives the other answer.
  it("a declared class OVERRIDES prose that would classify transient", () => {
    const r: InvokeResponse = { ok: false, error: "module /invoke -> 503", reason: "bad-input" };
    expect(classifyTransientFailure("module /invoke -> 503")).toBe("transient"); // control
    expect(classifyInvokeFailure(r)).toBe("deterministic");
  });

  it("a declared class OVERRIDES prose that would classify deterministic", () => {
    const r: InvokeResponse = { ok: false, error: "CUDA out of memory", reason: "rate-limited" };
    expect(classifyTransientFailure("CUDA out of memory")).toBe("deterministic"); // control
    expect(classifyInvokeFailure(r)).toBe("transient");
  });

  it("the message can be reworded ARBITRARILY without moving the decision", () => {
    // The concrete harm #291 names: a module rewords its message and changes a retry decision it
    // never knew it was making. With a class declared, it cannot.
    const answers = new Set(
      [
        "module /invoke -> 503",
        "CUDA out of memory",
        "",
        "the flux capacitor is fluxing",
        "timed out; network unreachable; please try again later",
      ].map((error) => classifyInvokeFailure({ error, reason: "quota-exceeded" })),
    );
    expect([...answers]).toEqual(["deterministic"]);
  });

  it("ABSENT reason keeps the legacy prose path EXACTLY, both directions", () => {
    // Back-compat is the other half: a module that returns only prose today must not start
    // behaving differently. Absent means "has not adopted", never a class.
    for (const error of [
      "module /invoke -> 503",
      "module unreachable: fetch failed",
      "CUDA out of memory",
      'Invalid request body: field "resolution" must be one of ["720p"]',
      "module /poll -> 404",
    ]) {
      expect(classifyInvokeFailure({ error })).toBe(classifyTransientFailure(error));
    }
  });

  it("a MALFORMED reason degrades to prose at runtime, and is never coerced to a class", () => {
    // Refused at the gate (below), permissive at runtime: the split `participation` uses. The
    // runtime must not invent a class, so the answer equals the prose answer and nothing else.
    for (const reason of ["bad_input", "QUOTA-EXCEEDED", null, 7, {}, []]) {
      expect(classifyInvokeFailure({ error: "module /invoke -> 503", reason })).toBe("transient");
      expect(classifyInvokeFailure({ error: "CUDA out of memory", reason })).toBe("deterministic");
    }
  });
});

describe("core#291 conformance: the check can go RED", () => {
  // A gate nobody has watched refuse is not a gate. Every accepting case below is paired with the
  // rejecting case that proves the same code path can produce the other reading.
  it("accepts ok:false + error + a declared class, and NAMES the class", () => {
    for (const reason of INVOKE_FAILURE_REASONS) {
      const c = checkInvokeResponse({ ok: false, error: "nope", reason });
      expect(c.pass).toBe(true);
      expect(c.detail).toBe("ok:false + error + reason:" + reason);
    }
  });

  it("accepts ok:false + error with NO class, and says so in words", () => {
    // Back-compat: today's prose-only module still passes. But the report must not read the same as
    // an adopting module's, or non-adoption is invisible and the field never gets taken up.
    const c = checkInvokeResponse({ ok: false, error: "nope" });
    expect(c.pass).toBe(true);
    expect(c.detail).toContain("no reason");
    expect(c.detail).toContain("has not adopted");
    // An explicit `undefined` is the SAME wire body as omitting the key (JSON.stringify drops it),
    // so it must read as absent rather than as a malformed value.
    expect(checkInvokeResponse({ ok: false, error: "nope", reason: undefined }).pass).toBe(true);
  });

  it("REFUSES a malformed class, and the detail names the closed set", () => {
    const malformed: unknown[] = ["quota", "bad_input", "BAD-INPUT", "", null, 7, true, {}, ["bad-input"]];
    for (const reason of malformed) {
      const c = checkInvokeResponse({ ok: false, error: "nope", reason });
      expect(c.pass).toBe(false);
      expect(c.detail).toContain("is not one of");
      expect(c.detail).toContain("bad-input | unsupported");
    }
  });

  it("still refuses the pre-existing malformations, unchanged", () => {
    expect(checkInvokeResponse({ ok: false }).pass).toBe(false);
    expect(checkInvokeResponse({ ok: false, error: 7, reason: "bad-input" }).pass).toBe(false);
    expect(checkInvokeResponse({ output: {} }).pass).toBe(false);
    expect(checkInvokeResponse(null).pass).toBe(false);
    expect(checkInvokeResponse({ ok: true, output: { storyboard: {} } }).pass).toBe(true);
  });

  it("a DEGRADE is not a failure and is never asked for a class", () => {
    // The honest soft-degrade discipline: ok:true + passthrough + applied:[] + degraded:"<reason>".
    // It carries no `reason` because it is not a failure, and the envelope check must not start
    // demanding one -- conflating the two is exactly what would make a degrade get counted as a
    // fault. A polish miss never fails the chain; only malformed I/O fails loud.
    const degrade = {
      ok: true,
      output: { shot_id: "s1", clip_key: "renders/p1/clips/s1.mp4", out_fps: 24, frames: 48, applied: [], degraded: "upscale backend down" },
    };
    const c = checkInvokeResponse(degrade);
    expect(c.pass).toBe(true);
    expect(c.detail).toBe("ok:true + output");
    expect(c.detail).not.toContain("reason");
  });
});
