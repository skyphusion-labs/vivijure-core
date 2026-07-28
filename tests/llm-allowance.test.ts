import { describe, it, expect } from "vitest";
import { llmSpendAllowanceMicroUsd } from "../src/llm-allowance.js";

// The rejection rules are deliberately IDENTICAL to storageQuotaBytes. Two money knobs that parse
// differently is how one of them ends up holding a value the operator did not mean, so this suite
// mirrors tests/storage-quota.test.ts case for case rather than testing a shorter list.
describe("llmSpendAllowanceMicroUsd (the knob)", () => {
  it("is OFF for unset, empty, zero and anything that is not a positive integer string", () => {
    expect(llmSpendAllowanceMicroUsd({})).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "" })).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "   " })).toBeNull();
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "0" })).toBeNull();
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

  // null and 0 are different facts and only one of them is expressible by absence.
  it("distinguishes NO allowance from an allowance of zero", () => {
    expect(llmSpendAllowanceMicroUsd({})).toBeNull();
    // "0" is refused rather than returned as 0: an allowance of zero would make every request
    // overage from the first token, which nobody configures by leaving a field blank.
    expect(llmSpendAllowanceMicroUsd({ LLM_SPEND_ALLOWANCE_MICRO_USD: "0" })).toBeNull();
  });
});
