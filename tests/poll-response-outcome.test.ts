/**
 * local#304 / PollResponse failure-arm widen: an explicit `outcome` on ok:false must typecheck
 * and round-trip. Without the core type field, tsc rejects the literal (TS2353) even though
 * spread markers already rode the same arm.
 */
import { describe, expect, it } from "vitest";
import type { PollFailureOutcome, PollResponse } from "../src/modules/types.js";

function asFailure(
  outcome: PollFailureOutcome,
  extra?: { runpodStatus?: string; errorType?: string },
): PollResponse {
  return {
    ok: false,
    error: "probe",
    outcome,
    ...extra,
  };
}

describe("PollResponse failure arm (local#304)", () => {
  it("accepts each closed outcome on an ok:false literal", () => {
    const outcomes: PollFailureOutcome[] = ["backend-error", "failed", "gone", "cancelled"];
    for (const outcome of outcomes) {
      const r = asFailure(outcome);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.outcome).toBe(outcome);
    }
  });

  it("accepts runpodStatus + errorType alongside outcome", () => {
    const r = asFailure("failed", { runpodStatus: "FAILED", errorType: "HarnessError" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.runpodStatus).toBe("FAILED");
      expect(r.errorType).toBe("HarnessError");
      expect(r.outcome).toBe("failed");
    }
  });

  it("still allows bare ok:false (additive, not required)", () => {
    const r: PollResponse = { ok: false, error: "legacy" };
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.outcome).toBeUndefined();
      expect(r.error).toBe("legacy");
    }
  });
});
