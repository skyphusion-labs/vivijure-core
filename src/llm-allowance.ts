// The LLM bundled-allowance operator knob (cp#195), host-neutral.
//
// WHY IT IS IN CORE, and it is the same argument that put the storage quota here (core#52): a tenant
// studio runs the PUBLISHED release unmodified, so a knob that exists only for the hosted tier is
// the named drift tripwire. It ships to hosted and self-host in one release. Hosted sets it per
// tenant; a self-hoster sets it to bound their own model spend on the same surface.
//
// SHAPE: deliberately the same as R2_STORAGE_QUOTA_BYTES, down to the rejection rules, because two
// money knobs that parse differently is how one of them gets a value the operator did not mean.
//
//   LLM_SPEND_ALLOWANCE_MICRO_USD="<integer>"   unset / 0 / non-integer / non-string = NO allowance.
//
// WHY MICRO-USD IS IN THE NAME even though it is long. This is the one lane where a unit confusion
// is a money bug: a bare `_ALLOWANCE` invites somebody to put dollars in it, and 5 dollars written
// as `5` against a micro-USD reader is a five-million-fold error in the customer`s favour, or the
// reverse. Integer micro-USD matches `credit_ledger` and the LLM spend rows, so the number is
// converted exactly once, at ingest, and never again.
//
// AND WHY THE VALUE CARRIES NO UNIT SUFFIX: same rule as the bytes knob. There is no "5USD" parsing,
// because a mis-parsed unit is an order-of-magnitude error on somebody`s bill.
//
// NOTE WHAT "beside SPEND_DAILY_CEILING" DOES NOT MEAN. cp#195 places this knob beside
// SPEND_DAILY_CEILING, and that means the same PLACE and the same SHAPE, not the same UNIT:
// SPEND_DAILY_CEILING counts SUBMISSIONS per UTC day, not dollars (vivijure-cf src/rate-limit.ts,
// "Submissions, not dollars"). Rollins checked that rather than reading across from the name, which
// is why this knob is money and that one is not.
//
// SCOPE, stated so the next reader does not go looking for enforcement that is deliberately absent:
// this module is the KNOB, not the meter. Measuring LLM spend needs the gateway log stream, which
// the party holding the gateway credential reads; the decision that turns a measured window into a
// charge is a separate, pure, INJECTED core (cp#195 meter-debit) precisely so it can be tested
// against the values that matter rather than the ones an environment happens to hold. What lives
// here is the one place the NUMBER is parsed, so both doors read the operator`s intent identically.

/** Env slice this knob needs. Structural, so each host passes its own bag with no adapter. */
export interface LlmAllowanceEnv {
  /** Positive integer MICRO-USD as a string; unset / 0 / garbage = no allowance. */
  LLM_SPEND_ALLOWANCE_MICRO_USD?: unknown;
}

/**
 * The configured bundled allowance in integer micro-USD, or null when none is configured.
 *
 * null means NO ALLOWANCE, which is not the same as an allowance of zero and must not be collapsed
 * into one: no allowance means this deployment has not bundled anything, and a zero allowance would
 * mean every micro-USD is overage from the first request. Only one of those can be expressed by
 * absence, so absence takes the meaning that matches an unconfigured studio.
 */
export function llmSpendAllowanceMicroUsd(env: LlmAllowanceEnv): number | null {
  const raw = env.LLM_SPEND_ALLOWANCE_MICRO_USD;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}
