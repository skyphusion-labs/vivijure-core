// Shared module GET /ready contract (core#239).
//
// The wire was prose in two repos: vivijure-cf emits it, vivijure-control-plane
// classifies it. Nothing kept the pair in step. This file is the type plus the
// classifier. Control-plane keeps its local copy until a core release publishes
// this; the pair test is the SoT until then.

export type ModuleReadyVerdict =
  | "ready"
  | "not_visible_yet"
  | "unverifiable"
  | "misconfigured";

export interface ModuleReadyCredentials {
  runpod_api_key?: boolean;
  runpod_endpoint_id?: boolean;
}

export interface ModuleReadyBody {
  ok?: boolean;
  module?: string;
  credentials?: ModuleReadyCredentials;
  telemetry?: { job_log?: unknown };
  door?: unknown;
}

export type DoorBacking = { token: boolean } | null | "unreadable";

export function parseDoorBacking(raw: unknown): DoorBacking {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "unreadable";
  const token = (raw as { token?: unknown }).token;
  if (typeof token !== "boolean") return "unreadable";
  return { token };
}

/**
 * What one /ready answer means.
 *
 *  - ready           the transport the module named is usable
 *  - not_visible_yet endpoint id present, key absent (propagation)
 *  - unverifiable    404: no /ready route, or nothing at that script
 *  - misconfigured   any other shape
 *
 * Ask the module which credentials it needs. Door-backed and public-slug
 * modules must not be required to show runpod_endpoint_id.
 */
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
  if (typeof body.module !== "string" || body.module !== expectedModule) {
    return "misconfigured";
  }

  const door = parseDoorBacking(body.door);
  if (door && door !== "unreadable") {
    return door.token ? "ready" : "misconfigured";
  }

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
