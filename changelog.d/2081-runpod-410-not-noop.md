### Fix: a 410 from REST v1 is not a healthy reconcile no-op (fleet-chezmoi#2081)

`fetchEndpointWorkersMax` folds every non-OK GET into `workersMax: null`, and `reconcileRunpodEndpointWorkersMax` treated that null as a best-effort skip. A 404 or 410 from `https://rest.runpod.io/v1` therefore came back as `{ ok: true, action: "none" }`, the same result as a healthy no-op. REST v1 retires on 2026-11-15 with 410 Gone, so workersMax restoration would stop on that date with nothing to see.

A 404 or 410 now returns `ok: false`, with the status and guidance that names the retirement date and the successor base `https://api.runpod.io/v2`. `RUNPOD_REST_BASE` stays on v1. This change does not retarget callers.

- 401 and 403 stay the scoped-key guidance. They are returned before the 404/410 branch.
- A 5xx and a network error stay the best-effort no-op, so a transient read does not block submit.
- `disabled: true` skips the REST read and returns the healthy no-op. The submit helper maps `RUNPOD_RECONCILE_DISABLED` onto that flag. Only explicit on-values count: `true`, `1`, and the strings `1`, `true`, `yes`, `on`. `0` and `false` stay off, and the read still reaches `rest.runpod.io`.
- This package does not read `process.env`. A caller that invokes `reconcileRunpodEndpointWorkersMax` itself passes `disabled`. The env is read only by this package's submit helper.

**For a host.** A submit that reconciles (`RUNPOD_WORKERS_MAX` set, direct route) now fails when the v1 read is 404 or 410, instead of proceeding. Set `RUNPOD_RECONCILE_DISABLED` to an on-value to keep the old skip. Callers outside this package that call reconcile directly do not see that env. They fail closed on 2026-11-15 unless they pass `disabled: true`. Wiring that flag through those callers is not in this change.
