### fix(core): install batch fallback; CAS give-up is falsy

`setInstallConfig` goes through `runPreparedWrites`, so a host without
`Database.batch` writes sequentially instead of throwing (core#221).
`casUpdateImageList` / `addRefs` return a falsy row after giving up on
CAS contention, so an abandoned write is not a success (core#234).
`setRenderAudioOutput` merge is pinned: a partial audio update cannot
clobber sibling `output_json` fields (core#225). The D1 test harness now
returns rows from `INSERT`/`UPDATE ... RETURNING` so those paths can be
driven against a real engine.
