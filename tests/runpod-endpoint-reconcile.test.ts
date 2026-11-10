import { describe, it, expect, vi } from "vitest";
import {
  endpointWorkersMaxNeedsRestore,
  idleScaleDownGuidance,
  fetchEndpointWorkersMax,
  patchEndpointWorkersMax,
  reconcileRunpodEndpointWorkersMax,
  RUNPOD_REST_BASE,
} from "../src/runpod-endpoint-reconcile.js";

// The v2 surface, from RunPod's published OpenAPI (servers[0] https://api.runpod.io, paths
// GET and PATCH /v2/serverless/{id}, schemas Endpoint.workers and UpdateEndpointRequest.workers,
// both EndpointWorkers {min, max, idleTimeout}). Written as LITERALS on purpose: an assertion
// built from RUNPOD_REST_BASE follows the constant wherever it points and cannot go red when the
// constant is wrong (fleet-chezmoi#2083).
const V2_ENDPOINT_URL = "https://api.runpod.io/v2/serverless/ep1";

/** A v2 Endpoint body, trimmed to the fields the reconcile reads, in the documented nesting. */
const v2Endpoint = (max: number, min = 0) => ({ id: "ep1", name: "x", workers: { min, max } });

describe("RUNPOD_REST_BASE", () => {
  it("is the v2 base, not the retiring rest.runpod.io/v1", () => {
    expect(RUNPOD_REST_BASE).toBe("https://api.runpod.io/v2");
  });
});

describe("endpointWorkersMaxNeedsRestore (pure)", () => {
  it("true when live workersMax is below spec", () => {
    expect(endpointWorkersMaxNeedsRestore(0, 4)).toBe(true);
    expect(endpointWorkersMaxNeedsRestore(2, 4)).toBe(true);
  });
  it("false when live meets or exceeds spec", () => {
    expect(endpointWorkersMaxNeedsRestore(4, 4)).toBe(false);
    expect(endpointWorkersMaxNeedsRestore(6, 4)).toBe(false);
  });
  it("false when live is unknown", () => {
    expect(endpointWorkersMaxNeedsRestore(null, 4)).toBe(false);
    expect(endpointWorkersMaxNeedsRestore(undefined, 4)).toBe(false);
  });
});

describe("idleScaleDownGuidance (pure)", () => {
  it("names the endpoint and expected workersMax", () => {
    const g = idleScaleDownGuidance("ep123", 4);
    expect(g).toContain("ep123");
    expect(g).toContain("4");
    expect(g).toContain("idle scale-down");
  });
});

describe("fetchEndpointWorkersMax (v2 GET /v2/serverless/{id})", () => {
  it("GETs the v2 serverless URL with a Bearer key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(v2Endpoint(2)), { status: 200 }));
    await fetchEndpointWorkersMax("k", "ep1", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(V2_ENDPOINT_URL);
    expect(new URL(url).hostname).toBe("api.runpod.io");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("parses workers.max and workers.min from the nested v2 Endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(v2Endpoint(2, 1)), { status: 200 }));
    const r = await fetchEndpointWorkersMax("k", "ep1", fetchImpl);
    expect(r.workersMax).toBe(2);
    expect(r.workersMin).toBe(1);
  });

  it("does NOT read the v1 flat workersMax: v2 never sends it, so honouring it would mask a shape miss", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: "ep1", workersMax: 2, workersMin: 0 }), { status: 200 }),
    );
    const r = await fetchEndpointWorkersMax("k", "ep1", fetchImpl);
    expect(r.workersMax).toBeNull();
    expect(r.workersMin).toBeNull();
  });

  it("surfaces 401 without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const r = await fetchEndpointWorkersMax("k", "ep1", fetchImpl);
    expect(r.status).toBe(401);
    expect(r.workersMax).toBeNull();
  });
});

describe("patchEndpointWorkersMax (v2 PATCH /v2/serverless/{id})", () => {
  it("PATCHes the v2 URL with the nested workers body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(v2Endpoint(4)), { status: 200 }));
    const r = await patchEndpointWorkersMax("k", "ep1", 4, 0, fetchImpl);
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(V2_ENDPOINT_URL);
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ workers: { max: 4, min: 0 } });
  });

  it("omits workers.min when none is given (PATCH leaves omitted fields untouched)", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await patchEndpointWorkersMax("k", "ep1", 3, undefined, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ workers: { max: 3 } });
  });
});

describe("reconcileRunpodEndpointWorkersMax", () => {
  it("no-ops when live workersMax already meets spec", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify(v2Endpoint(4)), { status: 200 });
      }
      throw new Error("unexpected PATCH");
    });
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "k",
      endpointId: "ep1",
      spec: { workersMax: 4 },
      fetchImpl,
    });
    expect(r).toEqual({ ok: true, action: "none" });
  });

  it("PATCHes when live workersMax is below spec (full management key)", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method, body: init?.body as string | undefined });
      if (method === "GET") {
        return new Response(JSON.stringify(v2Endpoint(0, 0)), { status: 200 });
      }
      if (method === "PATCH") {
        return new Response(JSON.stringify(v2Endpoint(4, 0)), { status: 200 });
      }
      throw new Error(`unexpected ${method}`);
    });
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "k",
      endpointId: "ep1",
      spec: { workersMax: 4 },
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action).toBe("restored");
      expect(r.workersMaxBefore).toBe(0);
      expect(r.workersMaxAfter).toBe(4);
    }
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", V2_ENDPOINT_URL],
      ["PATCH", V2_ENDPOINT_URL],
    ]);
    expect(JSON.parse(calls[1].body!)).toEqual({ workers: { max: 4, min: 0 } });
  });

  it("restores workers.min from the live read when the spec gives none", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        bodies.push(init.body as string);
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify(v2Endpoint(0, 1)), { status: 200 });
    });
    await reconcileRunpodEndpointWorkersMax({ apiKey: "k", endpointId: "ep1", spec: { workersMax: 3 }, fetchImpl });
    expect(JSON.parse(bodies[0])).toEqual({ workers: { max: 3, min: 1 } });
  });

  it("returns guidance when PATCH is 401 (scoped invoke key)", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify(v2Endpoint(0)), { status: 200 });
      }
      return new Response("forbidden", { status: 401 });
    });
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "scoped",
      endpointId: "ep1",
      spec: { workersMax: 2 },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.guidance).toContain("ep1");
      expect(r.guidance).toContain("idle scale-down");
    }
  });

  it("a 410 on the read is a failure, not a healthy no-op (keeps #527)", async () => {
    const fetchImpl = vi.fn(async () => new Response("gone", { status: 410 }));
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "k",
      endpointId: "ep1",
      spec: { workersMax: 4 },
      fetchImpl,
    });
    expect(r).not.toEqual({ ok: true, action: "none" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(410);
      expect(r.error).toContain("410");
      expect(r.guidance).toContain(V2_ENDPOINT_URL);
      expect(r.guidance).toContain("not a healthy no-op");
      expect(r.guidance).not.toContain("idle scale-down");
    }
  });

  it("a 404 on the read is the same terminal failure (v2: not found or not visible to this key)", async () => {
    const fetchImpl = vi.fn(async () => new Response("missing", { status: 404 }));
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "k",
      endpointId: "ep1",
      spec: { workersMax: 4 },
      fetchImpl,
    });
    expect(r).not.toEqual({ ok: true, action: "none" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.guidance).toContain(V2_ENDPOINT_URL);
    }
  });

  it("a 502 stays a healthy no-op so submit is not blocked on a transient read", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 502 }));
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "k",
      endpointId: "ep1",
      spec: { workersMax: 4 },
      fetchImpl,
    });
    expect(r).toEqual({ ok: true, action: "none" });
  });

  it("a network error stays a healthy no-op", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNRESET");
    });
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "k",
      endpointId: "ep1",
      spec: { workersMax: 4 },
      fetchImpl,
    });
    expect(r).toEqual({ ok: true, action: "none" });
  });

  it("GET 401 stays the scoped-key failure, not the terminal-read failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "scoped",
      endpointId: "ep1",
      spec: { workersMax: 2 },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.guidance).toContain("idle scale-down");
      expect(r.guidance).not.toContain("not a healthy no-op");
    }
  });

  it("GET 403 stays the scoped-key failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "scoped",
      endpointId: "ep1",
      spec: { workersMax: 2 },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.guidance).toContain("idle scale-down");
    }
  });

  it("disabled skips the REST read even when the read would return 410", async () => {
    const fetchImpl = vi.fn(async () => new Response("gone", { status: 410 }));
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "k",
      endpointId: "ep1",
      spec: { workersMax: 4 },
      fetchImpl,
      disabled: true,
    });
    expect(r).toEqual({ ok: true, action: "none" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
