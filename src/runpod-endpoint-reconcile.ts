// Pre-render RunPod endpoint reconcile (cf#61): RunPod idle scale-down sets workersMax to 0 after
// 7 days without requests (sticky until manually raised). Before dispatching a job, detect
// workersMax below the configured spec and PATCH it back when the API key allows management.
//
// Key custody (#60): invoke-scoped tenant keys can GET /health and submit jobs but get 401 on
// the management PATCH. DIY operators with a full read/write key get silent reconcile; hosted
// tenants get honest guidance instead of a cryptic "no workers available" failure.
//
// Transport: RunPod REST v2 (fleet-chezmoi#2083). REST v1 retires 2026-11-15, so the read is
// GET {base}/serverless/{id} and the restore is PATCH {base}/serverless/{id}, with the worker
// bounds nested as workers.min / workers.max (OpenAPI schema EndpointWorkers, used by both the
// Endpoint response and UpdateEndpointRequest). PATCH changes only the fields present in the body.
//
// A 404 or 410 on the read is terminal: it must not look like the healthy no-op used for a
// transient miss (network error, 5xx) (#527). On v2 a 404 means the endpoint is not found or not
// visible to this key. 401 and 403 stay the scoped-key path.
//
// Not this API: the serverless INVOKE API (run, status, cancel, health in runpod-submit.ts) is a
// different host and product, not REST v1, and it is untouched here.

export const RUNPOD_REST_BASE = "https://api.runpod.io/v2";

/** The v2 management URL for one serverless endpoint. */
export function serverlessEndpointUrl(endpointId: string): string {
  return `${RUNPOD_REST_BASE}/serverless/${encodeURIComponent(endpointId)}`;
}

export interface EndpointWorkersSpec {
  /** The workersMax this endpoint was provisioned with (required to reconcile). */
  workersMax: number;
  workersMin?: number;
}

export type EndpointReconcileResult =
  | { ok: true; action: "none" | "restored"; workersMaxBefore?: number; workersMaxAfter?: number }
  | { ok: false; error: string; guidance?: string; status?: number };

export interface EndpointReconcileOpts {
  apiKey: string;
  endpointId: string;
  spec: EndpointWorkersSpec;
  fetchImpl?: typeof fetch;
  /**
   * Kill switch. When true, do not call REST and return a healthy no-op.
   * Fail-closed on a retired v1 would otherwise block submit. This package does not read
   * process.env; the submit helper maps RUNPOD_RECONCILE_DISABLED onto this flag. Callers
   * that invoke reconcile themselves pass it directly.
   */
  disabled?: boolean;
}

/** Pure: does the live workersMax need restoring to the spec? */
export function endpointWorkersMaxNeedsRestore(
  current: number | null | undefined,
  expected: number,
): boolean {
  if (current == null || !Number.isFinite(current)) return false;
  return current < expected;
}

/** Honest operator-facing text when the endpoint read answers 404 or 410. Not a transient read. */
export function terminalEndpointReadGuidance(endpointId: string, status: number): string {
  return (
    `RunPod returned HTTP ${status} for ${serverlessEndpointUrl(endpointId)}. ` +
    "The endpoint id is wrong, the endpoint was deleted, or this API key cannot see it. " +
    "workersMax was not restored. This is not a healthy no-op. " +
    "Check the endpoint id in the RunPod console (Serverless), or set RUNPOD_RECONCILE_DISABLED to skip the reconcile."
  );
}

/** Honest operator-facing text when a scoped invoke key cannot PATCH. */
export function idleScaleDownGuidance(endpointId: string, expectedWorkersMax: number): string {
  return (
    `RunPod endpoint ${endpointId} workersMax is below the configured ${expectedWorkersMax} ` +
    "(likely RunPod idle scale-down after 7 days without requests). " +
    "Raise workersMax in the RunPod console (Serverless → your endpoint → Max workers), " +
    "or run the reconcile script with a management-capable API key."
  );
}

function authHeaders(apiKey: string, json = false): Record<string, string> {
  const h: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  if (json) h["content-type"] = "application/json";
  return h;
}

/**
 * GET /v2/serverless/{id} for workers.max and workers.min. Returns null on transport or parse
 * failure, and null when the body lacks the nested v2 fields (a v1-shaped flat workersMax is not
 * read: v2 never sends it).
 */
export async function fetchEndpointWorkersMax(
  apiKey: string,
  endpointId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ workersMax: number | null; workersMin: number | null; status: number; detail?: string }> {
  const url = serverlessEndpointUrl(endpointId);
  let resp: Response;
  try {
    resp = await fetchImpl(url, { method: "GET", headers: authHeaders(apiKey) });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { workersMax: null, workersMin: null, status: 0, detail: `network: ${m}` };
  }
  const text = await resp.text();
  if (!resp.ok) {
    return { workersMax: null, workersMin: null, status: resp.status, detail: text.slice(0, 300) };
  }
  try {
    const body = JSON.parse(text) as { workers?: { max?: unknown; min?: unknown } | null } | null;
    const w = body && typeof body.workers === "object" && body.workers !== null ? body.workers : {};
    const workersMax = typeof w.max === "number" ? w.max : null;
    const workersMin = typeof w.min === "number" ? w.min : null;
    return { workersMax, workersMin, status: resp.status };
  } catch {
    return { workersMax: null, workersMin: null, status: resp.status, detail: "non-JSON response" };
  }
}

/** PATCH /v2/serverless/{id} with { workers: { max, min? } }. Omitted fields are left as they are. */
export async function patchEndpointWorkersMax(
  apiKey: string,
  endpointId: string,
  workersMax: number,
  workersMin?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const url = serverlessEndpointUrl(endpointId);
  const workers: { max: number; min?: number } = { max: workersMax };
  if (workersMin != null) workers.min = workersMin;
  const payload = { workers };
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "PATCH",
      headers: authHeaders(apiKey, true),
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, detail: `network: ${m}` };
  }
  const text = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, detail: text.slice(0, 300) };
  return { ok: true, status: resp.status };
}

/**
 * Reconcile one endpoint before submit. When the key cannot manage endpoints (401 or 403), returns
 * honest guidance instead of proceeding into a dead submit. A 404 or 410 is also a failure: a
 * missing or retired endpoint read must not be reported as a healthy no-op (#527). Network errors and 5xx stay best-effort.
 */
export async function reconcileRunpodEndpointWorkersMax(
  opts: EndpointReconcileOpts,
): Promise<EndpointReconcileResult> {
  if (opts.disabled) {
    return { ok: true, action: "none" };
  }
  const { apiKey, endpointId, spec } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const expected = spec.workersMax;
  if (!Number.isFinite(expected) || expected <= 0) {
    return { ok: true, action: "none" };
  }

  const live = await fetchEndpointWorkersMax(apiKey, endpointId, fetchImpl);
  if (live.status === 401 || live.status === 403) {
    return {
      ok: false,
      error: `RunPod endpoint config unreadable with this API key (HTTP ${live.status})`,
      guidance: idleScaleDownGuidance(endpointId, expected),
      status: live.status,
    };
  }
  if (live.status === 404 || live.status === 410) {
    return {
      ok: false,
      error: `RunPod endpoint read is terminal: HTTP ${live.status}`,
      guidance: terminalEndpointReadGuidance(endpointId, live.status),
      status: live.status,
    };
  }
  if (live.workersMax == null) {
    // Best-effort: do not block submit on a transient config read failure (network error, 5xx,
    // or any other non-terminal status). 404 and 410 are returned above.
    return { ok: true, action: "none" };
  }
  if (!endpointWorkersMaxNeedsRestore(live.workersMax, expected)) {
    return { ok: true, action: "none" };
  }

  const patch = await patchEndpointWorkersMax(
    apiKey,
    endpointId,
    expected,
    spec.workersMin ?? live.workersMin ?? 0,
    fetchImpl,
  );
  if (!patch.ok) {
    if (patch.status === 401 || patch.status === 403) {
      return {
        ok: false,
        error: `RunPod endpoint workersMax restore failed: HTTP ${patch.status}`,
        guidance: idleScaleDownGuidance(endpointId, expected),
        status: patch.status,
      };
    }
    return {
      ok: false,
      error: `RunPod endpoint workersMax restore failed: ${patch.detail ?? `HTTP ${patch.status}`}`,
      status: patch.status,
    };
  }
  return {
    ok: true,
    action: "restored",
    workersMaxBefore: live.workersMax,
    workersMaxAfter: expected,
  };
}
