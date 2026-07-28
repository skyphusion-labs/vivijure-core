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
//   LLM_SPEND_ALLOWANCE_MICRO_USD="<integer>"   unset / empty / non-integer / non-string = NO
//                                              allowance. "0" is a REAL zero, not an absence;
//                                              see llmSpendAllowanceMicroUsd for why that one
//                                              rule differs from the bytes knob.
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
 * null means NO ALLOWANCE and 0 means an allowance OF ZERO. They are different facts and must not
 * be collapsed: no allowance is a deployment that has not bundled anything, while a zero allowance
 * is a deliberate operator choice that every micro-USD is overage from the first request. Only one
 * of them can be expressed by absence, so absence takes the unconfigured meaning.
 *
 * WHY "0" IS ACCEPTED HERE WHEN "0" IS REFUSED BY R2_STORAGE_QUOTA_BYTES. Everything else about
 * these two knobs parses identically, on purpose, so this one difference is worth the paragraph.
 *
 * A storage ceiling of zero says "this studio may store nothing", which is not a configuration
 * anybody wants and is indistinguishable in effect from the quota being off, so refusing it costs
 * nothing and catches a typo. A bundled allowance of zero says "this tier includes nothing, bill
 * from the first token", which is a REAL tier somebody sells. Refusing it would leave an operator
 * unable to express an intent they legitimately hold, and the workaround (leave it blank) means the
 * opposite thing. A knob that cannot express a legitimate intent is a defect, not a safeguard.
 *
 * This ALSO keeps core and the control plane agreeing about one string across a binding boundary.
 * The plane treats a configured "0" as a deliberate zero, and if core read the same character as
 * "nothing configured" then an operator setting zero would see a studio reporting no allowance at
 * all. Two meanings for one value either side of a binding is the drift class this whole lane keeps
 * closing.
 *
 * CONSUMER TRAP, stated because the type invites it: 0 is FALSY. Test the result against null, not
 * for truthiness, or a deliberate zero allowance silently becomes an unconfigured one.
 */
export function llmSpendAllowanceMicroUsd(env: LlmAllowanceEnv): number | null {
  const raw = env.LLM_SPEND_ALLOWANCE_MICRO_USD;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}
