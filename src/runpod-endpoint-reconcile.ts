// Pre-render RunPod endpoint reconcile (cf#61): RunPod idle scale-down sets workersMax to 0 after
// 7 days without requests (sticky until manually raised). Before dispatching a job, detect
// workersMax below the configured spec and PATCH it back when the API key allows management.
//
// Key custody (#60): invoke-scoped tenant keys can GET /health and submit jobs but get 401 on
// PATCH /endpoints/{id}. DIY operators with a full graphql-R/W key get silent reconcile; hosted
// tenants get honest guidance instead of a cryptic "no workers available" failure.

export const RUNPOD_REST_BASE = "https://rest.runpod.io/v1";

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
}

/** Pure: does the live workersMax need restoring to the spec? */
export function endpointWorkersMaxNeedsRestore(
  current: number | null | undefined,
  expected: number,
): boolean {
  if (current == null || !Number.isFinite(current)) return false;
  return current < expected;
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

/** GET /v1/endpoints/{id} for workersMax. Returns null workersMax on transport/parse failure. */
export async function fetchEndpointWorkersMax(
  apiKey: string,
  endpointId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ workersMax: number | null; workersMin: number | null; status: number; detail?: string }> {
  const url = `${RUNPOD_REST_BASE}/endpoints/${endpointId}`;
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
    const body = JSON.parse(text) as { workersMax?: unknown; workersMin?: unknown };
    const workersMax = typeof body.workersMax === "number" ? body.workersMax : null;
    const workersMin = typeof body.workersMin === "number" ? body.workersMin : null;
    return { workersMax, workersMin, status: resp.status };
  } catch {
    return { workersMax: null, workersMin: null, status: resp.status, detail: "non-JSON response" };
  }
}

/** PATCH /v1/endpoints/{id} workersMax (and optional workersMin). */
export async function patchEndpointWorkersMax(
  apiKey: string,
  endpointId: string,
  workersMax: number,
  workersMin?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const url = `${RUNPOD_REST_BASE}/endpoints/${endpointId}`;
  const payload: Record<string, number> = { workersMax };
  if (workersMin != null) payload.workersMin = workersMin;
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
 * Reconcile one endpoint before submit. When the key cannot manage endpoints (401), returns honest
 * guidance instead of proceeding into a dead submit.
 */
export async function reconcileRunpodEndpointWorkersMax(
  opts: EndpointReconcileOpts,
): Promise<EndpointReconcileResult> {
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
  if (live.workersMax == null) {
    // Best-effort: do not block submit on a transient config read failure.
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
