### fix(film-model): distinguish terminal refusal from transient failure in finish-shot recovery

Ref: GHSA-hcr9-8jc2-9q4c.

`FinishShot.status` carried two different terminal facts under one label. A step that did not
deliver is RECOVERABLE: the finish phase is built around R2 presence being authoritative, so a
later pass (or the same pass's reclaim) may still find the artifact and complete the shot
(#141/#166, RUN #29). A REFUSED shot is the opposite kind of fact: a decision that the shot is not
to be delivered, which no later pass may revisit. Both were `failed`, and every recovery path in the
phase keys off the status.

`refused` is now its own terminal status, set by `applyFinishOutputOrRefuse`, and the separation is
enforced by the type system rather than by a condition each recovery path has to remember:

- `RecoverableFinishShot` is a branded type. The only way to obtain one is `finishShotRecoverable`,
  which admits `pending` and `failed` only, so a refused shot does not inhabit the type at all.
  `adoptFinishStepOutput` and `adoptFinishStepFromR2` take that type, and `finishShotAdoptableFromR2`
  is now a type guard that narrows through the single definition. A recovery path added later gets the
  guarantee by declaring its parameter, with no new condition to remember and no way to opt out.
- `finishShotBlocksRender` / `finishPhaseBlockers` replace the inline `status === "failed"` test in the
  finish phase's terminal judgment, so a refused shot stops the render exactly as a failed one does
  instead of falling through to assemble. This is the half a new status would otherwise break, and it
  is asserted.
- `FinishSummary` gains `refused`. Without its own bucket a refused shot would appear in none of them
  and `total` would not reconcile, which is an absence rendering as a value.

`tests/finish-refusal-terminal.test.ts` asserts both directions, because only one of them is about
the refusal. Every refused fixture is produced by running the real refusal path rather than by writing
the status literal, which no shipped code emits: a hand-built fixture would let a status-reading guard
pass whatever that path actually does. The CONTROL half pins the recovery the `failed` branch exists
for, at the final chain index and frozen mid-poll, plus the mid-chain non-adoption and the ordinary
soft-degrade fold. A change that separated the states by disabling recovery would pass half this file
and is not a fix.

`error` is still cleared on an adopted shot, which is correct there (the finished artifact is the
source of truth) and unreachable for a refusal, whose reason is what the render reports.

Files: `src/film-model.ts`, `src/film-orchestrator.ts`, `tests/finish-refusal-terminal.test.ts`,
`tests/apply-finish-output-226.test.ts`.
