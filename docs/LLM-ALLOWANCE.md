# `LLM_SPEND_ALLOWANCE_MICRO_USD`

The bundled LLM allowance knob (cp#195). One implementation in `src/llm-allowance.ts`, read
identically by both panels. Hosted sets it per tenant; a self-hoster sets it to bound their own model
spend on the same surface, in the same release. Same rule that put the storage quota in core: a knob
that exists only for the hosted tier is the drift tripwire.

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

## No allowance is not a zero allowance

`null` (no allowance) and `0` are different facts, and only one of them can be expressed by absence.
No allowance means this deployment has not bundled anything; a zero allowance would mean every
micro-USD is overage from the first request. `"0"` is therefore REFUSED rather than returned as `0`,
because nobody configures "charge from the first token" by leaving a field blank.

## Scope: this is the knob, not the meter

Measuring LLM spend needs the gateway log stream, which the party holding the gateway credential
reads. The decision that turns a measured window into a charge is a separate, pure, INJECTED core, so
it can be tested against the values that matter rather than the ones an environment happens to hold.
What lives here is the single place the NUMBER is parsed, so both doors read the operator intent
identically.
