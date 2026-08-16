### fix(finish): persist FinishOutput.degraded so a panel can show the cause (core#226)

`applyFinishOutput` copied `clip_key` and `applied` and swallowed `degraded`.
The only signal that survived was the `passthrough:` tag, so a no-face degrade
and a door timeout were one literal. The fold now keeps the reason; the
summary exposes `reasons[]`; the done payload carries `{ degraded, reasons }`
when a finish chain ran. CSAM refusals fail the shot. They never degrade.
