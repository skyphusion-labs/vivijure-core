// Where a RunPod call actually goes, and what credential it carries (cp#321, cp#288, cf#394).
//
// PROVENANCE, and it is the whole reason this file sits in core rather than in a host. This is
// `vivijure-cf@d84e413:modules/_shared/runpod-route.ts` MOVED here under the cp#321 ruling:
//
//   > move cf's `modules/_shared/runpod-route.ts` INTO core and have both sides import it.
//   > Do NOT write a second implementation.
//
// A second copy would be cf#403 committed deliberately: a suite that constructs both halves of a
// cross-repo contract from its own copy cannot detect a rename on the other side, so both halves
// move together in the test and independently in production. cf imports these symbols from here;
// their NAMES are therefore part of the published surface and are not free to change.
//
// ------------------------------------------------------------------------------------------------
// WHY THIS EXISTS. On the shared hosted tier no tenant-namespace script may hold a RunPod
// credential (CLAUDE.md, Conrad 2026-08-02: a consumer reaches RunPod through our product or not at
// all, BYOK excepted). The control plane therefore stands a proxy in front of RunPod: the tenant
// worker calls the plane, the plane holds the pool key and calls RunPod.
//
// The plane deliberately mounted that proxy at RUNPOD'S OWN URL SHAPE
// (vivijure-control-plane/src/runpod-proxy-route-match.ts) -- `<base>/<endpoint>` plus `/run`,
// `/status/<id>`, `/cancel/<id>` or `/health`, byte-identical suffixes -- so the caller-side change
// is a base string and a bearer, and not a rewrite of every call site.
//
// ------------------------------------------------------------------------------------------------
// THE BRANCH IS ON `RUNPOD_PROXY_BASE` BEING BOUND. IT IS NOT A FAILOVER, AND THAT DISTINCTION IS
// THE WHOLE SAFETY ARGUMENT.
//
//   bound   -> proxied. Bearer is the plane token. We never touch api.runpod.ai.
//   unbound -> direct.  Bearer is RUNPOD_API_KEY, byte-for-byte the behaviour that shipped before.
//
// It must NEVER become "the proxy failed, so fall back to the direct key". A shared tenant that
// could fall back to a direct key is a shared tenant holding a RunPod credential, which is the exact
// thing the proxy exists to make impossible. A proxied caller with a missing or broken token
// REFUSES HONESTLY; it does not find another way to RunPod.
//
// ORDERING, and it is load-bearing (cf#394, cp#321): the consumer learns this base BEFORE the plane
// stops installing the RunPod key. Reversed, every hosted render breaks. That is why the unbound
// branch is the untouched original path and why this file ships ahead of any plane change. Stated as
// an invariant rather than as a status, because a status goes stale: a caller with the pair bound
// takes the proxied branch and a caller without it takes the direct branch, at every point in the
// rollout, and BOTH are permanent.
//
// THE UNBOUND BRANCH IS A PRODUCT, NOT A MIGRATION CRUTCH. Read the word "fallback" here as
// "the self-host door", because that is what it is. The estate ships TWO products (Conrad,
// 2026-08-03): individual self-hosters running on their own infrastructure with their own RunPod
// account, and shared hosted tenants reaching RunPod through the plane. The unbound path is the
// entire first product and it is permanently supported. Nobody should ever propose deleting it once
// the plane half lands -- doing so would remove the self-host door, not finish a migration.
//
// PARITY follows from that rather than being a separate promise: dedicated, BYO and self-host bind
// nothing here, so their path does not change at all. A self-hoster must never need our plane to
// render, and this file guarantees that by construction rather than by assertion.
//
// ------------------------------------------------------------------------------------------------
// CROSS-REPO CONTRACT. Two binding names, and the plane must bind exactly these:
//
//   RUNPOD_PROXY_BASE   plain_text, the plane's public origin + `/api/runpod/v2` (no trailing
//                       slash required; one is tolerated). Bound ONLY for runpod_mode = 'shared'.
//   RUNPOD_PROXY_TOKEN  secret, the per-tenant `vjp1.<tenant>.<mac>` credential minted by
//                       vivijure-control-plane/src/runpod-proxy-auth.ts mintTenantProxyToken.
//
// WHAT NO TEST IN THIS REPO CAN SEE, stated rather than papered over: core is not a dependency of
// vivijure-control-plane and vice versa, so the constants below are checked against the plane by
// STRING, not by import. A rename on the plane side is invisible here. The cf half of that gap is
// closed by construction -- cf imports these symbols rather than declaring its own -- and closing
// the plane half needs the plane to publish its constants, which is not this change.
// ------------------------------------------------------------------------------------------------

import { secretValue, type SecretsStoreSecret } from "./secret-store.js";

/** RunPod's own API base. The value every caller used unconditionally before this file existed. */
export const RUNPOD_DIRECT_BASE = "https://api.runpod.ai/v2";

/**
 * Attribution header the plane reads off a submit (`MODULE_HEADER` in
 * vivijure-control-plane/src/runpod-proxy-routes.ts). TENANT-ASSERTED and treated as such upstream:
 * it labels a metering row, it never prices one. Sent anyway, because without it every proxied job
 * lands in the plane's ledger with a null module and the meter cannot say what the spend was for.
 */
export const RUNPOD_MODULE_HEADER = "x-vivijure-module";

export interface RunpodRoute {
  /** Absolute base with no trailing slash. Append `/<endpointId>` then a RunPod verb suffix. */
  readonly base: string;
  /** The bearer to present: the plane token when proxied, the RunPod key when direct. */
  readonly credential: string;
  /** True when RUNPOD_PROXY_BASE was bound. Read it for DIAGNOSIS, never to pick a fallback. */
  readonly proxied: boolean;
}

/**
 * Decide the route for one request.
 *
 * `proxyBase` is whitespace-trimmed and trailing slashes are stripped, because a plain_text binding
 * is hand-configured and a stray `/` would produce `//<endpoint>` -- a URL that still resolves on
 * most stacks and would make this untestable by inspection.
 *
 * An all-whitespace `RUNPOD_PROXY_BASE` is treated as UNBOUND rather than as a proxy base of "".
 * The alternative is a caller that thinks it is proxied and builds `/<endpoint>/run` as a relative
 * URL, which throws deep inside fetch rather than at the guard that exists to catch it.
 */
export function resolveRunpodRoute(
  proxyBase: string | undefined,
  proxyToken: string,
  apiKey: string,
): RunpodRoute {
  const base = stripTrailingSlashes((proxyBase ?? "").trim());
  if (base) return { base, credential: proxyToken, proxied: true };
  return { base: RUNPOD_DIRECT_BASE, credential: apiKey, proxied: false };
}

/** Strip trailing ASCII '/' without a regex (CodeQL: ReDoS on /\/+$/ over env input). Mirrors the
 *  helper in runpod-submit.ts, which cannot be imported here without a cycle. */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end -= 1;
  return end === s.length ? s : s.slice(0, end);
}

/** `<base>/<endpointId>`. The four RunPod verb suffixes append to this unchanged, on both routes. */
export function runpodEndpointUrl(route: RunpodRoute, endpointId: string): string {
  return route.base + "/" + endpointId;
}

/**
 * Headers for a RunPod call. The module name is attribution only and is omitted on the direct
 * route, where nothing reads it and adding a header to a vendor request buys nothing.
 */
export function runpodHeaders(route: RunpodRoute, moduleName?: string): Record<string, string> {
  const h: Record<string, string> = { authorization: "Bearer " + route.credential };
  if (route.proxied && moduleName) h[RUNPOD_MODULE_HEADER] = moduleName;
  return h;
}

/**
 * Classify an absent credential HONESTLY, preserving the cf#114 distinction on both routes.
 *
 * cf#114: the endpoint id is a plain_text binding written at UPLOAD while the credential is a
 * secret written LATER, so endpoint-present + credential-absent is diagnostic of PROPAGATION, not
 * of misconfiguration. Saying "not configured" about it once sent a real tenant chasing a
 * correctly-configured credential.
 *
 * The proxied route inherits that shape exactly -- RUNPOD_PROXY_BASE is plain_text at upload,
 * RUNPOD_PROXY_TOKEN is a secret installed after -- and it gets its OWN message naming its OWN
 * bindings. A proxied caller reporting "RUNPOD_API_KEY not configured" would send an operator to
 * look for a key that must not exist on that worker at all.
 */
export function runpodCredentialProblem(route: RunpodRoute, endpointPresent: boolean): string | null {
  const credentialName = runpodCredentialName(route);
  if (route.credential && endpointPresent) return null;
  if (endpointPresent) return "credential not yet visible on this worker version (retry shortly)";
  // FOURTH BRANCH, and it is the whole point of splitting these: credential present, endpoint
  // absent. Naming the credential here would report a binding that is FINE as unconfigured, which
  // is cf#114's own failure committed inside the function written to prevent it -- an operator sent
  // to check a token that is sitting right there, while the thing actually missing goes unnamed.
  if (route.credential) return "RUNPOD_ENDPOINT_ID not configured";
  return `${credentialName} / RUNPOD_ENDPOINT_ID not configured`;
}

/**
 * The NAME of the binding that carries this route's credential.
 *
 * Where the whole credential guard is one inline `if (!credential)`, what it needs is the right
 * NOUN. Naming RUNPOD_API_KEY on a proxied worker would point an operator at a binding that must
 * not exist there, which is the same class of lie cf#114 was filed about.
 */
export function runpodCredentialName(route: RunpodRoute): string {
  return route.proxied ? "RUNPOD_PROXY_TOKEN" : "RUNPOD_API_KEY";
}

/** The bindings this helper reads. Widened to `| string` because callers already pass a plain
 *  string in tests and local dev, and a resolver that only understood Secrets Store would make the
 *  proxied path the one path no test could drive. */
export interface RunpodRouteEnv {
  RUNPOD_API_KEY?: SecretsStoreSecret | string;
  /** Plain_text, bound by the plane for `runpod_mode = 'shared'` tenants only. */
  RUNPOD_PROXY_BASE?: SecretsStoreSecret | string;
  /** Secret, the per-tenant `vjp1.<tenant>.<mac>` plane credential. */
  RUNPOD_PROXY_TOKEN?: SecretsStoreSecret | string;
}

/**
 * Resolve the route for this request from the environment.
 *
 * BOTH credentials are read every time, deliberately. Reading only the one the branch will use
 * would make the caller unable to say which binding it was missing, which is the whole content of
 * the cf#114 diagnosis. The unused one is dropped on the floor and never leaves this function.
 *
 * `RUNPOD_PROXY_BASE` is read through `secretValue` too, even though the plane binds it as
 * plain_text. A plain string returns byte-for-byte; a Secrets Store handle would otherwise
 * stringify to `[object Object]`, which is truthy, which would put a caller on the proxied branch
 * with a garbage base. Accepting both shapes costs nothing and removes that failure entirely.
 */
export async function runpodRoute(env: RunpodRouteEnv): Promise<RunpodRoute> {
  const [proxyBase, proxyToken, apiKey] = await Promise.all([
    secretValue(env.RUNPOD_PROXY_BASE),
    secretValue(env.RUNPOD_PROXY_TOKEN),
    secretValue(env.RUNPOD_API_KEY),
  ]);
  return resolveRunpodRoute(proxyBase, proxyToken, apiKey);
}

// ------------------------------------------------------------------------------------------------
// THE THIRD STATE ON THE POLL PATH (cf#398, the cf-side half of cp#288).
//
// THE DEFECT THIS CLOSES. A poll that handles an unreadable upstream by reporting "still pending"
// was correct while the upstream was RunPod: a blip means ask again. Once the upstream is OURS, the
// identical code turns a degraded, mid-deploy or refusing plane into a job that never completes and
// never errors. That is why the plane emits a HEADER rather than an error body: a refusal it
// authored is distinguishable from a vendor response it merely relayed.
//
// WHAT THE PLANE ACTUALLY SENDS. Measured at vivijure-control-plane@1da6075, all non-2xx, none of
// them a pass-through of an upstream response:
//
//   poll   runpod-proxy-poll-routes.ts  unauthorized 401, endpoint_not_allowed 403
//   poll   runpod-proxy-poll.ts         credential-unavailable 503
//   submit runpod-proxy-routes.ts       unauthorized 401, unknown_tenant/tenant_not_live/
//                                       tenant_suspended/not_shared_mode/endpoint_not_allowed 403,
//                                       bad_body 400, plus a 503 planeUnavailable
//
// A transport failure REACHING RunPod is deliberately NOT given the header: it returns 502 with no
// header, because mislabelling a vendor hiccup as our outage is a different wrong answer, not a fix.
//
// GATED ON `route.proxied`, and that is not belt-and-braces. The header means "our plane refused".
// On the direct route there is no plane, so honouring a header that arrives from api.runpod.ai
// would let a vendor response change a self-hoster's outcome. Gating it makes the self-host door
// provably untouched by this change rather than untouched by assertion.
// ------------------------------------------------------------------------------------------------

/** Emitted by the plane on a plane-AUTHORED refusal; its value is the reason. Must stay byte-equal
 *  to `PLANE_REFUSAL_HEADER` in vivijure-control-plane/src/runpod-proxy-poll.ts. */
export const PLANE_REFUSAL_HEADER = "x-vivijure-plane-refusal";

/** Only what this needs off a Response, so a test can hand in a plain object and so nothing here
 *  depends on the body having parsed. A refusal body always parses today; that is a property of the
 *  plane's current code, not of the contract, and this check must not rest on it. */
export interface PlaneRefusalCarrier {
  readonly headers: { get(name: string): string | null };
}

/**
 * The reason the PLANE refused, or null if this is not a plane refusal.
 *
 * Null covers three genuinely different things and all three must keep today's behaviour: the
 * direct route (no plane exists), a normal proxied response, and a proxy 502 saying it could not
 * reach RunPod. Only the header separates the plane's own refusal from everything else.
 */
export function planeRefusalReason(route: RunpodRoute, resp: PlaneRefusalCarrier): string | null {
  if (!route.proxied) return null;
  const raw = resp.headers.get(PLANE_REFUSAL_HEADER);
  if (!raw) return null;
  // Trimmed and bounded because this string is rendered into a render row. A blank header is not a
  // reason and is treated as no refusal at all; the plane never emits one, and inventing a refusal
  // out of an empty header would fail a job on a header a proxy stripped the value from.
  const reason = raw.trim().slice(0, 120);
  return reason || null;
}

/**
 * The error text for a refused call. ONE wording for every consumer, so an operator seeing it in a
 * render row learns the same thing whichever caller produced it, and so the sentence cannot drift
 * into a dozen variants. Names the plane explicitly: the single most expensive misreading available
 * here is "RunPod is down" when the answer is our own plane.
 *
 * `what` DEFAULTS TO "poll" so this returns the cf wording BYTE-FOR-BYTE when called with two
 * arguments, which is what makes cf's adoption of this file a pure import swap rather than a
 * user-visible string change. The default arm is pinned by a test against the literal cf sentence.
 * Core reaches RunPod for submit and cancel as well as poll, and "refused this poll" on a submit
 * would be a small lie in an error an operator reads at exactly the wrong moment; the poll tail
 * ("not observable until it clears") is likewise only true of a poll.
 */
export function planeRefusalError(subject: string, reason: string, what: string = "poll"): string {
  const tail =
    what === "poll"
      ? " and the job is not observable until it clears."
      : " and it did not reach RunPod.";
  return (
    subject +
    ": the control plane refused this " +
    what +
    " (" +
    reason +
    "). This is a plane refusal, not a RunPod failure," +
    tail
  );
}
