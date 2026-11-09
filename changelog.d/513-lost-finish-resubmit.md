### Fix: an assemble job the door marks lost to a container restart is re-submitted at once (vivijure-core#513)

vivijure-cf#1377 marks a finish job lost to a container restart: the bound door answers its status poll with HTTP 404 and `lost: "instance_restarted"` when the Durable Object recorded which instance took the job and a different instance answered. Core read every 404 as "possibly transient", so a lost job waited out the 12-poll not-found streak and then failed instead of being re-run.

Per the lead ruling on the issue: a 404 marked exactly `lost: "instance_restarted"` (`FINISH_JOB_LOST_REASON`) now re-submits on that tick, under the same output key, with freshly presigned URLs. An unmarked 404 keeps the streak exactly as before, and so does any other `lost` value, a non-object body or an unreadable one. Re-submits are counted on the poll state (`AssemblePollState.lost`) and capped at `ASSEMBLE_LOST_RESUBMIT_MAX` (3); past it, or when the re-submit itself is refused, the assemble fails by name. The per-replica fan-out path (no bound door) never reads the mark, because a replica there has peers.

The tick takes a new `repayload` option, because a poll tick is given a payload with no live URLs (a caller presigns only when it submits). The four assemble and mux callers in the film and scatter orchestrators now build their presigned payload in one closure and pass it; without `repayload` a marked 404 is an ordinary one. `tests/assemble-lost-resubmit-513.test.ts` scans `src/` and fails on a call site that does not pass it.

**For a host.** Nothing to change. A lost job on the bound finish door is re-run within the tick that sees it, not 12 polls later.
