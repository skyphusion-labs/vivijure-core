### fix(content-validate): spend the /inspect retry budget on the condition it was written for

`callVideoFinishInspect` retried a THROWN fetch three times at 1500ms, because the
loop's break tested `resp && resp.status !== 503 ...` and a throw leaves `resp` null,
which is falsy, which is not a break. `contentValidateDoneClips` walks shots
SEQUENTIALLY, so with the container down that is about 3s per shot: roughly 15s on
the 5-shot film cf#851 was found on, and about 51s of a finish pass on a 17-shot one,
re-paid on later ticks because core#30 says not to persist the skip.

A thrown fetch (NXDOMAIN, connection refused, a container that died before binding
8000) is not the gateway-busy condition the backoff exists for, and one attempt
establishes it. A `videoFinishFetch` that RESOLVES to null is the same class and was
sitting in the same loop for the same reason.

Second, a per-pass circuit breaker: once one shot establishes that the tier is not
serving, the remaining shots in that pass do not re-probe it. They still get the
cf#856 `content_unmeasured` record, because the film is equally unvouched-for either
way and a record that depended on probe ORDER would be a worse lie than no record.
O(shots) transport failures become O(1) per pass, and nothing latches beyond the
pass: the next tick starts clean.

**The 503/504 retry is deliberately unchanged**, and there is a test asserting the
full budget is still spent on it. That one is the container saying "busy, come back",
and cutting it would trade this latency problem for a coverage problem: more false
`unmeasured` records, which is precisely the state cf#856 exists to make visible.

The breaker trips on a typed `unreachable` flag, never on a reason string. A string
match is not a relationship, and a reason is prose that someone will reword without
thinking about a breaker. A 2xx with an unparseable body is explicitly NOT unreachable
(the tier is up; that one clip is not readable) and does not trip it.

Refs core#321, vivijure-cf#856, vivijure-cf#851, core#30.
