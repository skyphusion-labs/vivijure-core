// Shared module GET /ready wire type + classifier (core#239 / cp#468).
//
// The contract used to be prose in two repos. This is the owned type. Control-plane keeps its
// local classifier until a core release; this file is what it will import.

/** Wire envelope a module answers on GET /ready. Extra fields are ignored, not refused. */
export interface ModuleReadyBody {
  ok?: boolean;
  module?: string;
  /**
   * Which keys appear is itself information. A public-slug module reports runpod_api_key and
   * OMITS runpod_endpoint_id (absent != false). A door-backed module may omit both.
   */
  credentials?: { runpod_api_key?: boolean; runpod_endpoint_id?: boolean };
  /** Unparsed on purpose (cp#378): a narrower declaration hid a string-vs-boolean drift. */
  telemetry?: { job_log?: unknown };
  /**
   * Present ONLY when a door is bound. Absence means not door-backed, never "door broken".
   * Unparsed on purpose; narrowing happens in parseDoorBacking.
   */
  door?: unknown;
}

/**
 * Narrowed to the ONE field the gate acts on. The wire also carries bound/route/routes;
 * requiring those is a rename away from a failed provision (cp#468).
 */
export type DoorBacking = { token: boolean } | null | "unreadable";

export function parseDoorBacking(raw: unknown): DoorBacking {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "unreadable";
  const token = (raw as { token?: unknown }).token;
  if (typeof token !== "boolean") return "unreadable";
  return { token };
}

/**
 *  - ready           chosen transport is visible
 *  - not_visible_yet endpoint id present / public-slug key absent (the only retryable shape)
 *  - unverifiable    404: no /ready on this script (image predates the route, or script missing)
 *  - misconfigured   any other shape, including a module-echo mismatch
 */
export type ModuleReadyVerdict = "ready" | "not_visible_yet" | "unverifiable" | "misconfigured";

/** Classify one GET /ready answer. Ask the module which credentials it needs (cp#468). */
export function classifyReadyResponse(
  status: number,
  text: string,
  expectedModule: string,
): ModuleReadyVerdict {
  if (status === 404) return "unverifiable";
  if (status !== 200) return "misconfigured";
  let body: ModuleReadyBody;
  try {
    body = JSON.parse(text) as ModuleReadyBody;
  } catch {
    return "misconfigured";
  }
  if (typeof body.module !== "string" || body.module !== expectedModule) return "misconfigured";

  // Door first: a door-backed module answers about a transport that does not use RunPod creds.
  const door = parseDoorBacking(body.door);
  if (door && door !== "unreadable") {
    return door.token ? "ready" : "misconfigured";
  }
  // Unreadable door falls through (cp#323: refusing an unrecognised shape rebuilt a provision outage).

  const creds = body.credentials;
  if (!creds || typeof creds.runpod_api_key !== "boolean") return "misconfigured";

  if (creds.runpod_endpoint_id === undefined) {
    return creds.runpod_api_key ? "ready" : "not_visible_yet";
  }
  if (typeof creds.runpod_endpoint_id !== "boolean") return "misconfigured";

  if (creds.runpod_api_key && creds.runpod_endpoint_id) return "ready";
  if (creds.runpod_endpoint_id && !creds.runpod_api_key) return "not_visible_yet";
  return "misconfigured";
}
