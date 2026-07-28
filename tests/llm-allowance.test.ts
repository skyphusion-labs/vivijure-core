import { describe, it, expect } from "vitest";
import { llmSpendAllowanceMicroUsd } from "../src/llm-allowance.js";

// The rejection rules are deliberately IDENTICAL to storageQuotaBytes. Two money knobs that parse
// differently is how one of them ends up holding a value the operator did not mean, so this suite
// mirrors tests/storage-quota.test.ts case for case rather than testing a shorter list.
describe("llmSpendAllowanceMicroUsd (the knob)", () => {
  it("is OFF for unset, empty and anything that is not a non-negative integer string", () => {
    expect(llmSpendAllowanceMicroUsd({})).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "" })).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "   " })).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "-5" })).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "1.5" })).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "abc" })).toBeNull();
    // NO unit parsing, exactly like the bytes knob: a mis-parsed unit is an order-of-magnitude
    // error on a bill, so "5USD" is refused rather than read as 5.
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "5USD" })).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "5 micro" })).toBeNull();
    // A host that bound a NUMBER rather than a string is not a configured allowance either.
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: 1000 })).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: null })).toBeNull();
  });

  it("accepts a positive integer, trimmed", () => {
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "1" })).toBe(1);
    // 5 USD expressed the only way this knob accepts it.
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: " 5000000 " })).toBe(5000000);
  });

  // CONTROL for the unit trap the name exists to prevent. If somebody ever "helpfully" made this
  // parse dollars, 5 would stop being 5 micro-USD and this assertion is what says so.
  it("CONTROL: the value is MICRO-USD, so 5 is five micro-USD and not five dollars", () => {
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "5" })).toBe(5);
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "5" })).not.toBe(5_000_000);
  });

  // null and 0 are different FACTS and only one of them is expressible by absence.
  it("distinguishes NO allowance from an allowance OF zero", () => {
    // Nothing configured.
    expect(llmSpendAllowanceMicroUsd({})).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "  " })).toBeNull();
    // A deliberate zero-included tier: bill from the first token. A real thing somebody sells, and
    // the only way an operator can say it.
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "0" })).toBe(0);
  });

  // CONTROL for the divergence this rule exists to prevent. The control plane treats a configured
  // "0" as a deliberate zero; if core read the same character as "nothing configured", an operator
  // setting zero would see a studio reporting no allowance at all. Two meanings for one value on
  // either side of a binding is the drift class this lane keeps closing.
  it("CONTROL: a configured zero is NOT the same answer as an unconfigured knob", () => {
    const configuredZero = llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "0" });
    const unconfigured = llmSpendAllowanceMicroUsd({});
    expect(configuredZero).not.toBe(unconfigured);
    // And the trap the type invites: 0 is falsy, so a truthiness test collapses them again.
    expect(Boolean(configuredZero)).toBe(Boolean(unconfigured));
    expect(configuredZero === null).toBe(false);
  });

  // The one rule that differs from R2_STORAGE_QUOTA_BYTES, pinned so the difference is deliberate
  // rather than a drift somebody later harmonises away.
  it("differs from the bytes knob on zero, and ONLY on zero", () => {
    // A zero storage ceiling means "store nothing", indistinguishable from off, so it is refused
    // there. A zero allowance means "nothing included", which is a real tier.
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "0" })).toBe(0);
    // Everything else still parses identically.
    for (const bad of ["", "   ", "-1", "1.5", "abc", "5USD"]) {
      expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: bad })).toBeNull();
    }
    // A SHARED QUIRK, pinned rather than discovered: Number() accepts exponent notation, so both
    // knobs read "1e3" as 1000. Recorded here because it surprised me writing this test, and
    // because tightening it would change the bytes knob, whose behaviour this release must not
    // touch. If it is ever tightened, both move together.
  });
});
