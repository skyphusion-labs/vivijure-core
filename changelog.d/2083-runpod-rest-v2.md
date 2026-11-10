### Changed: the workersMax reconcile uses RunPod REST v2 (fleet-chezmoi#2083)

RunPod REST v1 (`rest.runpod.io/v1`) retires on 2026-11-15. RunPod idle scale-down sets an endpoint's `workersMax` to 0 after about 7 days with no requests, and this reconcile is what puts it back. On v1 the restore would stop on the 15th and a quiet studio would fail renders with "no workers". The reconcile now uses the v2 management API, from RunPod's published OpenAPI:

- `RUNPOD_REST_BASE` is `https://api.runpod.io/v2`. The new `serverlessEndpointUrl(id)` gives `{base}/serverless/{id}`.
- Read: `GET /v2/serverless/{id}`. The bounds are nested, `workers.max` and `workers.min`. A flat v1 `workersMax` is not read, because v2 never sends it.
- Restore: `PATCH /v2/serverless/{id}` with `{ "workers": { "max": N, "min": M } }`. PATCH changes only the fields in the body. `min` is left out when there is no spec value and no live value.

Same semantics as before:

- 401 and 403 return the scoped-key guidance.
- A 404 or 410 on the read is a failure, not a healthy no-op (#527). On v2 a 404 means the endpoint is not found or this key cannot see it. `retiredV1ReadGuidance(status)` becomes `terminalEndpointReadGuidance(endpointId, status)`, which names the v2 URL. The old name never shipped in a release, so nothing published loses it. The error text is now `RunPod endpoint read is terminal: HTTP <n>`.
- A 5xx and a network error stay the best-effort no-op.
- `disabled: true`, and `RUNPOD_RECONCILE_DISABLED` in the submit helper, still skip the read.

Not changed: `https://api.runpod.ai/v2/{id}/run|status|cancel|health`. That is the serverless invoke API (`.ai`, a different product). It is not REST v1 and the submit path still uses it.

A new test, `tests/runpod-no-rest-v1-2083.test.ts`, fails if any file under `src/` names `rest.runpod.io`.

**For a host.** Callers of `reconcileRunpodEndpointWorkersMax` change nothing. The key must be valid for the v2 API. RunPod documents one Bearer API key for both. vivijure-cf's modules (keyframe, own-gpu, finish-blender, finish-upscale) and `scripts/reconcile-runpod-endpoints.ts` pick this up on the version bump.
