# `LLM_SPEND_ALLOWANCE_MICRO_USD`

The bundled LLM allowance knob (cp#195). One implementation in `src/llm-allowance.ts`, read
identically by both panels. Hosted sets it per tenant; a self-hoster sets it to bound their own model
spend on the same surface, in the same release. Same rule that put the storage quota in core: a knob
that exists only for the hosted tier is the drift tripwire.

## THIS KNOB HAS NO CORE CONSUMER TODAY. Read this before setting it.

**Core does not measure LLM spend.** Measuring it needs a gateway log stream, which the party holding
the gateway credential reads; in the hosted deployment that is the control plane. So a self-hoster
who sets `LLM_SPEND_ALLOWANCE_MICRO_USD` without their own metering **gets nothing**: no display, no
enforcement, no overage. The value is parsed and validated and then nothing in this library acts on
it.

That is stated here in those words rather than left to be discovered, because a knob that quietly
does nothing is the exact failure this project keeps finding: a var reaches no consumer, everything
stays green, and the feature is dead. The asymmetry is real and it exists whether or not this knob
ships. What ships here is the SHARED CONTRACT for what a valid allowance is, so the hosted plane and
any future core consumer agree on one set of rules instead of growing two that drift.

Closing it properly means core being able to measure. That is tracked at core#107, along with the
note that the pure decision core currently living in the control plane moves here at the same time,
and not before: relocating decision code while the thing that feeds it stays elsewhere moves the
file without moving the capability.

## The knob

| Var | Default | Meaning |
|---|---|---|
| `LLM_SPEND_ALLOWANCE_MICRO_USD` | unset | Unset / `0` / non-integer / non-string = **no allowance**. A positive integer = the bundled allowance in **integer micro-USD**. |

Rejection rules are deliberately IDENTICAL to `R2_STORAGE_QUOTA_BYTES`, down to refusing `1.5` and
`5USD`. Two money knobs that parse differently is how one of them ends up holding a value the
operator did not mean.

```
LLM_SPEND_ALLOWANCE_MICRO_USD=5000000     # 5 USD
LLM_SPEND_ALLOWANCE_MICRO_USD=250000      # 0.25 USD
```

## Why the unit is in the NAME

This is the one lane where a unit confusion is a money bug. A bare `_ALLOWANCE` invites somebody to
put dollars in it, and `5` read as dollars against a micro-USD reader is a five-million-fold error,
in one direction or the other. Integer micro-USD matches `credit_ledger` and the LLM spend rows, so
the number is converted exactly once, at ingest, and never again.

The VALUE carries no unit suffix for the same reason the bytes knob does not: a mis-parsed unit is an
order-of-magnitude error on somebody`s bill, so `5USD` is refused rather than guessed at.

## What "beside `SPEND_DAILY_CEILING`" does and does not mean

cp#195 places this knob beside `SPEND_DAILY_CEILING`. That means the same PLACE and the same SHAPE,
**not the same unit**: `SPEND_DAILY_CEILING` counts SUBMISSIONS per UTC day, not dollars. That was
checked against the reading code rather than inferred from the name, which is exactly the sort of
cross-reading that would otherwise have shipped an order-of-magnitude bug inside a variable name.

## No allowance is not a zero allowance, and BOTH are expressible

`null` (nothing configured) and `0` (a deliberate zero) are different facts, and only one of them can
be expressed by absence. So absence takes the unconfigured meaning, and `"0"` is accepted as a real
zero.

| value | meaning |
|---|---|
| unset, empty, whitespace | no allowance is configured |
| `"0"` | a zero-included tier: bill from the first token |
| `"5000000"` | 5 USD included |
| `"-1"`, `"1.5"`, `"5USD"`, a non-string | refused, reads as unconfigured |

**This is the ONE rule that differs from `R2_STORAGE_QUOTA_BYTES`, which refuses `"0"`.** Everything
else parses identically on purpose, so the difference is worth stating rather than harmonising away:

- A storage ceiling of zero says "this studio may store nothing". Nobody configures that, and its
  effect is indistinguishable from the quota being off, so refusing it costs nothing and catches a
  typo.
- An allowance of zero says "this tier includes nothing". That is a real tier somebody sells, and
  refusing it would leave an operator unable to express an intent they legitimately hold, with the
  only workaround (leave it blank) meaning the opposite thing.

A knob that cannot express a legitimate intent is a defect, not a safeguard.

It also keeps core and the control plane agreeing about one string across a binding boundary. The
plane treats a configured `"0"` as a deliberate zero; if core read the same character as "nothing
configured", an operator setting zero would see a studio reporting no allowance at all. Two meanings
for one value on either side of a binding is a drift class, not a nuance.

**Consumer trap, because the type invites it:** `0` is falsy. Test the result against `null`, never
for truthiness, or a deliberate zero silently becomes an unconfigured one.

### A shared quirk, pinned rather than discovered

`Number()` accepts exponent notation, so BOTH knobs read `"1e3"` as `1000`. Verified against both
rather than assumed. It is recorded rather than fixed because tightening it would change
`R2_STORAGE_QUOTA_BYTES`, whose behaviour this release must not touch. If it is ever tightened, both
move together.

## Scope: this is the knob, not the meter

Measuring LLM spend needs the gateway log stream, which the party holding the gateway credential
reads. The decision that turns a measured window into a charge is a separate, pure, INJECTED core, so
it can be tested against the values that matter rather than the ones an environment happens to hold.
What lives here is the single place the NUMBER is parsed, so both doors read the operator intent
identically.
