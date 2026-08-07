import { describe, expect, it, vi } from "vitest";
import {
  PLANE_REFUSAL_HEADER,
  RUNPOD_DIRECT_BASE,
  RUNPOD_MODULE_HEADER,
  planeRefusalError,
  resolveRunpodRoute,
  runpodRoute,
} from "../src/runpod-route.js";
import {
  buildCancelUrl,
  buildStatusUrl,
  buildSubmitUrl,
  cancelRenderJob,
  pollRenderJob,
  runpodRequest,
  submitRenderJob,
} from "../src/runpod-submit.js";

// cp#321 step 1: core learns to reach RunPod THROUGH the control-plane proxy, with the direct key
// kept as the permanently supported self-host door.
//
// EVERY VALUE HERE IS NON-DEFAULT ON PURPOSE. On a default value an honoured request and a
// silently substituted one are byte-identical, so the base, the token and the key below are all
// distinctive strings: if the branch picks the wrong one, the assertion says which one it picked
// rather than merely failing.
const PLANE_BASE = "https://plane.example.test/api/runpod/v2";
const PLANE_TOKEN = "vjp1.tenant-42.plane-token-not-the-runpod-key";
const DIRECT_KEY = "direct-runpod-key-must-not-be-used-when-proxied";
const EP = "ep-abc";

/** Proxied tenant. Carries the direct key TOO, deliberately: the whole safety claim is that a
 *  bound proxy base wins and the direct key is never reachable, and an env without the key could
 *  not tell "the branch is right" from "there was nothing else to pick". */
const proxiedEnv = {
  RUNPOD_ENDPOINT_ID: EP,
  RUNPOD_API_KEY: DIRECT_KEY,
  RUNPOD_PROXY_BASE: PLANE_BASE,
  RUNPOD_PROXY_TOKEN: PLANE_TOKEN,
};

/** Self-host / dedicated / BYO: nothing bound. The CONTROL for every proxied assertion below. */
const directEnv = { RUNPOD_ENDPOINT_ID: EP, RUNPOD_API_KEY: DIRECT_KEY };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Records every call so an assertion can name what was requested, not just that something was.
 *  `calls` being non-empty is asserted explicitly wherever a "never called X" claim is made --
 *  a zero-call run satisfies "never called api.runpod.ai" vacuously. */
function recordingFetch(respond: () => Response) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), headers: { ...h } });
    return respond();
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls };
}

const fastOpts = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  sleep: async () => {},
  random: () => 0,
  backoffBaseMs: 1,
});

const okEnvelope = { id: "job-1", status: "IN_QUEUE" };

/**
 * The HOST a call went to, parsed.
 *
 * `url.includes("rest.runpod.io")` is not an assertion about a host: it is satisfied by any URL
 * that merely CONTAINS the string, including `https://evil.example/?x=rest.runpod.io`. CodeQL
 * flags it as js/incomplete-url-substring-sanitization (high), and it is also the unanchored-matcher
 * defect this crew keeps paying for -- in a file whose whole subject is "which origin did the
 * credential go to". A parsed hostname cannot be satisfied that way.
 *
 * CodeQL reported TWO of these; there were THREE. Fixing only the reported instances is how a
 * class stays open behind a green check.
 */
const hostOf = (url: string): string => new URL(url).hostname;

describe("resolveRunpodRoute: the branch is BOUND-ness, never a failover", () => {
  it("unbound -> direct route carrying the RunPod key", () => {
    const r = resolveRunpodRoute(undefined, PLANE_TOKEN, DIRECT_KEY);
    expect(r).toEqual({ base: RUNPOD_DIRECT_BASE, credential: DIRECT_KEY, proxied: false });
  });

  it("bound -> proxied route carrying the PLANE token, never the RunPod key", () => {
    const r = resolveRunpodRoute(PLANE_BASE, PLANE_TOKEN, DIRECT_KEY);
    expect(r.proxied).toBe(true);
    expect(r.base).toBe(PLANE_BASE);
    expect(r.credential).toBe(PLANE_TOKEN);
    expect(r.credential).not.toBe(DIRECT_KEY);
  });

  it("tolerates a hand-configured trailing slash and surrounding whitespace", () => {
    expect(resolveRunpodRoute(`  ${PLANE_BASE}//  `, PLANE_TOKEN, DIRECT_KEY).base).toBe(PLANE_BASE);
  });

  it("treats an all-whitespace base as UNBOUND, not as a proxy base of empty string", () => {
    const r = resolveRunpodRoute("   ", PLANE_TOKEN, DIRECT_KEY);
    expect(r.proxied).toBe(false);
    expect(r.base).toBe(RUNPOD_DIRECT_BASE);
  });

  it("resolves a Secrets Store handle for the base, not just a plain string", async () => {
    const r = await runpodRoute({
      RUNPOD_PROXY_BASE: { get: async () => PLANE_BASE },
      RUNPOD_PROXY_TOKEN: { get: async () => PLANE_TOKEN },
      RUNPOD_API_KEY: DIRECT_KEY,
    });
    // The failure this excludes is stringifying the handle to "[object Object]", which is truthy
    // and would put the caller on the proxied branch with a garbage base.
    expect(r.base).toBe(PLANE_BASE);
    expect(r.proxied).toBe(true);
  });
});

describe("URL shape: the proxy is mounted at RunPod's own suffixes", () => {
  const route = resolveRunpodRoute(PLANE_BASE, PLANE_TOKEN, DIRECT_KEY);

  it("keeps the direct URLs byte-identical to what shipped before this change", () => {
    expect(buildSubmitUrl(EP)).toBe(`https://api.runpod.ai/v2/${EP}/run`);
    expect(buildStatusUrl(EP, "j1")).toBe(`https://api.runpod.ai/v2/${EP}/status/j1`);
    expect(buildCancelUrl(EP, "j1")).toBe(`https://api.runpod.ai/v2/${EP}/cancel/j1`);
  });

  it("DERIVES the proxied URL as base-swap only (suffixes never transcribed)", () => {
    // Derived rather than written out: a hand-typed expectation here would be a second copy of the
    // suffix grammar, and two copies of one contract is the defect this file's helper exists to
    // remove. If a suffix ever changed on one route only, this comparison is what goes red.
    for (const direct of [buildSubmitUrl(EP), buildStatusUrl(EP, "j1"), buildCancelUrl(EP, "j1")]) {
      const suffix = direct.slice(RUNPOD_DIRECT_BASE.length);
      expect(suffix.startsWith(`/${EP}/`)).toBe(true);
      expect(
        [buildSubmitUrl(EP, route), buildStatusUrl(EP, "j1", route), buildCancelUrl(EP, "j1", route)],
      ).toContain(PLANE_BASE + suffix);
    }
  });

  it("pins the plane's mount prefix as a STRING (core cannot import the plane's constant)", () => {
    // THE LIMIT, stated rather than papered over: vivijure-control-plane is not a dependency of
    // this package, so `PROXY_UPSTREAM_PREFIX` (src/runpod-proxy-route-match.ts) is checked here by
    // string. A rename on the plane side is invisible to this suite. The cf half of the same
    // contract IS closed by construction, because cf imports these symbols rather than declaring
    // its own; closing the plane half needs the plane to publish its constants.
    expect(PLANE_BASE.endsWith("/api/runpod/v2")).toBe(true);
  });
});

describe("submit on a proxied tenant reaches the plane and never RunPod", () => {
  it("POSTs the plane URL with the plane token as bearer", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(okEnvelope));
    const r = await submitRenderJob(
      proxiedEnv as never,
      { bundleKey: "bundles/x.tar.gz" },
      fastOpts(fetchImpl),
    );
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1); // floor: the "never called RunPod" assertions below are not vacuous
    expect(calls[0].url).toBe(`${PLANE_BASE}/${EP}/run`);
    expect(calls[0].headers.authorization).toBe(`Bearer ${PLANE_TOKEN}`);
    expect(calls.map((c) => hostOf(c.url))).not.toContain("api.runpod.ai");
    expect(JSON.stringify(calls[0].headers)).not.toContain(DIRECT_KEY);
  });

  it("CONTROL: the same call unbound goes to RunPod with the RunPod key (the self-host door)", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(okEnvelope));
    const r = await submitRenderJob(
      directEnv as never,
      { bundleKey: "bundles/x.tar.gz" },
      fastOpts(fetchImpl),
    );
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`https://api.runpod.ai/v2/${EP}/run`);
    expect(calls[0].headers.authorization).toBe(`Bearer ${DIRECT_KEY}`);
  });

  it("routes poll and cancel through the plane too", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ id: "j1", status: "COMPLETED" }),
    );
    await pollRenderJob(proxiedEnv as never, "j1", fastOpts(fetchImpl));
    await cancelRenderJob(proxiedEnv as never, "j1", fastOpts(fetchImpl));
    expect(calls.map((c) => c.url)).toEqual([
      `${PLANE_BASE}/${EP}/status/j1`,
      `${PLANE_BASE}/${EP}/cancel/j1`,
    ]);
  });

  it("sends the module attribution header only on the proxied route", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(okEnvelope));
    await runpodRequest(
      proxiedEnv as never,
      { method: "POST", url: `${PLANE_BASE}/${EP}/run`, body: "{}", label: "submit", moduleName: "finish-upscale" },
      fastOpts(fetchImpl),
    );
    await runpodRequest(
      directEnv as never,
      { method: "POST", url: `${RUNPOD_DIRECT_BASE}/${EP}/run`, body: "{}", label: "submit", moduleName: "finish-upscale" },
      fastOpts(fetchImpl),
    );
    expect(calls.length).toBe(2);
    expect(calls[0].headers[RUNPOD_MODULE_HEADER]).toBe("finish-upscale");
    expect(calls[1].headers[RUNPOD_MODULE_HEADER]).toBeUndefined();
  });
});

describe("a proxied worker REFUSES rather than falling back to the RunPod key", () => {
  it("names RUNPOD_PROXY_TOKEN and makes no request at all, with the direct key sitting right there", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(okEnvelope));
    const r = await submitRenderJob(
      { ...proxiedEnv, RUNPOD_PROXY_TOKEN: "" } as never,
      { bundleKey: "bundles/x.tar.gz" },
      fastOpts(fetchImpl),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("RUNPOD_PROXY_TOKEN");
      // Naming RUNPOD_API_KEY here would send an operator hunting a key that must not exist on a
      // proxied worker at all (cf#114's failure committed inside the fix for it).
      expect(r.error).not.toContain("RUNPOD_API_KEY");
    }
    expect(calls.length).toBe(0);
  });

  it("CONTROL: unbound with no key keeps the self-hoster's sentence byte-for-byte", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(okEnvelope));
    const r = await submitRenderJob(
      { RUNPOD_ENDPOINT_ID: EP } as never,
      { bundleKey: "bundles/x.tar.gz" },
      fastOpts(fetchImpl),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(
        "RUNPOD_API_KEY must be set on the Worker (Secrets Store binding or npx wrangler secret put)",
      );
    }
  });

  it("refuses a URL that does not belong to the resolved route, rather than presenting the token to it", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(okEnvelope));
    const r = await runpodRequest(
      proxiedEnv as never,
      // A caller that built its URL against RunPod on a proxied worker. Without this guard the
      // PLANE token would be presented to api.runpod.ai.
      { method: "POST", url: `${RUNPOD_DIRECT_BASE}/${EP}/run`, body: "{}", label: "submit" },
      fastOpts(fetchImpl),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("route mismatch");
    expect(calls.length).toBe(0);
  });
});

describe("a plane refusal is reported as OURS, not as a RunPod failure", () => {
  it("uses the plane wording when the header is present on a proxied poll", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: "unauthorized" }, 401, { [PLANE_REFUSAL_HEADER]: "unauthorized" }),
    );
    const r = await pollRenderJob(proxiedEnv as never, "j1", fastOpts(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("the control plane refused this poll");
      expect(r.error).toContain("not a RunPod failure");
      expect(r.status).toBe(401);
    }
  });

  it("names the VERB, so a refused submit does not claim to be a poll", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: "not_shared_mode" }, 403, { [PLANE_REFUSAL_HEADER]: "not_shared_mode" }),
    );
    const r = await submitRenderJob(
      proxiedEnv as never,
      { bundleKey: "bundles/x.tar.gz" },
      fastOpts(fetchImpl),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("refused this submit");
  });

  it("CONTROL: the same header on an UNBOUND route changes nothing (self-host door untouched)", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: "boom" }, 401, { [PLANE_REFUSAL_HEADER]: "unauthorized" }),
    );
    const r = await pollRenderJob(directEnv as never, "j1", fastOpts(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("RunPod poll failed: boom");
      expect(r.error).not.toContain("control plane");
    }
  });

  it("a proxy 502 with NO header keeps the vendor wording (a hiccup is not our outage)", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ error: "upstream unreachable" }, 502));
    const r = await pollRenderJob(proxiedEnv as never, "j1", fastOpts(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("control plane refused");
  });

  it("the two-argument call is byte-identical to the sentence vivijure-cf ships today", () => {
    // cf adopts this file by import swap (cp#321 ruling). If this default arm drifts, fourteen
    // modules' user-visible error text changes silently, so the literal is pinned here.
    expect(planeRefusalError("finish-upscale", "unauthorized")).toBe(
      "finish-upscale: the control plane refused this poll (unauthorized). This is a plane refusal, " +
        "not a RunPod failure, and the job is not observable until it clears.",
    );
  });
});

describe("the account-level workers-max reconcile is skipped on a proxied tenant", () => {
  it("makes no rest.runpod.io call and goes straight to the plane", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(okEnvelope));
    await submitRenderJob(
      { ...proxiedEnv, RUNPOD_WORKERS_MAX: 3 } as never,
      { bundleKey: "bundles/x.tar.gz" },
      fastOpts(fetchImpl),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((c) => hostOf(c.url))).not.toContain("rest.runpod.io");
    expect(calls[0].url).toBe(`${PLANE_BASE}/${EP}/run`);
  });

  it("CONTROL: the same variable unbound DOES reach rest.runpod.io", async () => {
    // Without this the assertion above passes on any env that simply never reconciles, which is
    // indistinguishable from the skip being the thing that prevented it.
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ workersMax: 3 }));
    await submitRenderJob(
      { ...directEnv, RUNPOD_WORKERS_MAX: 3 } as never,
      { bundleKey: "bundles/x.tar.gz" },
      fastOpts(fetchImpl),
    );
    expect(calls.map((c) => hostOf(c.url))).toContain("rest.runpod.io");
  });
});
