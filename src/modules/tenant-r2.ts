// The per-job tenant R2 credential carried on the invoke envelope (cp#270, vivijure-backend#393).
//
// WHY THE ENVELOPE CARRIES A CREDENTIAL AT ALL, stated plainly rather than presented as free.
// Pooling the hosted shared tier means one RunPod endpoint serves many tenants, so the tenant's R2
// destination can no longer live in the endpoint's template environment: it has to arrive per job.
// The worker that SUBMITS is a tenant module worker, and it holds no R2 credential. Two ways to fix
// that, and neither is costless:
//
//   STANDING residency -- bind the tenant's R2 credential onto the module scripts. Every standing
//     copy joins the list of consumers that must be updated on every credential roll, with a silent
//     staleness failure mode. That bug has already happened here: vivijure-cf#83, where adopted
//     RunPod templates kept a revoked credential after a re-mint and the tenant's first render died
//     401 on R2.
//   BOUNDED residency -- the studio, which already holds the credential, passes it on the one hop to
//     the module, which uses it and drops it. Nothing new at rest, nothing new to go stale.
//
// This module is the bounded option. It is a real trade, not an absence of one: the credential now
// exists in a worker-to-worker request body for the duration of one call. What makes that
// acceptable is measured rather than assumed -- Cloudflare's `workers_trace_events` dataset carries
// no request-body field (its 13 fields are CPUTimeMs, DispatchNamespace, Entrypoint, Event,
// EventTimestampMs, EventType, Exceptions, Logs, Outcome, ScriptName, ScriptTags, ScriptVersion,
// WallTimeMs), and `Logs` is defined as console messages. So the platform does not capture the body;
// the only way this leaks is if OUR code writes it to a log, which `takeTenantR2` below and the
// module-side drift test exist to prevent.
//
// STANDING CONDITION, and it is the one configuration change that could turn this design unsafe
// without any code changing: enabling Logpush CUSTOM FIELDS on tenant module workers requires
// revisiting this decision. Custom Fields is the documented mechanism for capturing more of a
// request than the default dataset, so it is the trigger to re-check, not a hypothetical.

import type { InvokeRequest, ModuleManifest, RegisteredModule, TenantR2Config } from "./types.js";

export type { TenantR2Config };

/** The four studio env names the tenant credential is bound under (provisioner.ts:651-665). */
const ENV_KEYS = ["R2_S3_ENDPOINT", "R2_S3_ACCESS_KEY_ID", "R2_S3_SECRET_ACCESS_KEY", "R2_S3_BUCKET"] as const;

/**
 * A binding may be a plain string or a Secrets Store handle. Resolved the same way the rest of the
 * codebase does it, and a failed read is treated as ABSENT rather than throwing: a credential we
 * cannot read must degrade to "no block", which the backend answers by falling back to its own
 * environment. Throwing here would take down a render for a tenant on a DEDICATED endpoint, which
 * needs no block at all.
 */
async function readEnvValue(v: unknown): Promise<string> {
  if (typeof v === "string") return v;
  if (v && typeof (v as { get?: unknown }).get === "function") {
    try {
      return String(await (v as { get(): Promise<string> }).get());
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Build the block from the studio environment, or null when this host does not carry a full set.
 *
 * ALL FOUR OR NOTHING. A partial block is worse than no block: the backend REFUSES a malformed one
 * and fails the job, where an absent one falls back to the endpoint environment and works on every
 * dedicated endpoint we run today. So a half-configured host degrades to today's behaviour instead
 * of failing every render, and the incompleteness is visible in the returned null rather than in a
 * job that dies at the far end.
 */
export async function tenantR2FromEnv(env: Record<string, unknown>): Promise<TenantR2Config | null> {
  const [endpoint, accessKeyId, secretAccessKey, bucket] = await Promise.all(
    ENV_KEYS.map((k) => readEnvValue(env[k])),
  );
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    endpoint,
    access_key_id: accessKeyId,
    secret_access_key: secretAccessKey,
    bucket,
  };
}

/** Does this module's manifest ASK for the tenant credential? Data from the module, never a name
 *  check here -- the registry-projection rule: core must not branch on module identity. */
export const needsTenantR2 = (m: ModuleManifest | RegisteredModule): boolean =>
  Boolean((m as ModuleManifest).needs_tenant_r2);

/**
 * Attach the block to an invoke request, for a module that declares it needs one.
 *
 * OMIT, NEVER NULL. The backend refuses an explicit `"r2": null` rather than reading it as absent,
 * because the one thing a null must not do is silently mean "use the environment". So this returns
 * the request UNCHANGED when there is nothing to attach, and the key is simply not present. An
 * optional-field builder that sets `r2: undefined` would serialise to an absent key too, but only by
 * accident of JSON.stringify, and a future switch to a serialiser that emits nulls would break the
 * far end silently. Returning the original object makes the absence structural.
 */
export function withTenantR2<I>(
  request: InvokeRequest<I>,
  module: ModuleManifest | RegisteredModule,
  r2: TenantR2Config | null,
): InvokeRequest<I> {
  if (!needsTenantR2(module) || !r2) return request;
  return { ...request, r2 };
}

/**
 * STRIP AT THE BOUNDARY: read the block off an inbound request and REMOVE it, in one call.
 *
 * The mirror of the backend's `strip_from_payload`, and it exists for the same reason: the credential
 * must not survive past the point that consumes it, so no emitter, error path, or future log line
 * downstream can echo an object that still contains it. A module calls this once, at the top of its
 * handler, and thereafter holds a request that never had the field.
 *
 * `delete` on the caller's object is deliberate rather than returning a copy. A copy leaves the
 * ORIGINAL intact, and the original is the object every existing code path already has a reference
 * to -- which is exactly the thing that gets serialised into a log. Mutating is the only version
 * that actually removes the credential from the object in flight.
 */
export function takeTenantR2<I>(request: InvokeRequest<I>): TenantR2Config | null {
  const r2 = request.r2 ?? null;
  if ("r2" in request) delete (request as { r2?: unknown }).r2;
  return r2;
}
